// #1188's PR review r2 (Astra): its 112 own cases (`make-cases.py:5-24`: seven shapes over load or fromJson, depth 0 or
// 2, flipped and reversed or not), as `cases/own.json` holds them, analysed by `probe/keptseq2.mjs`
// (R/astra-m4-i1188-pr-review-r2-evidence/full-evidence.tar.gz).
export const cases = [
  [
    "three-contributors/load/depth0/flip0/reverse0",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet row0=[load("c0",default:good),peer]\nlet row1=[load("c1",default:bad),peer]\nlet row2=[load("c2",default:other),peer]\nexit\n',
  ],
  [
    "one-owner-two-paths/load/depth0/flip0/reverse0",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet row0=[{left:load("l0",default:good),right:load("r0",default:good)},{left:peer,right:peer}]\nlet row1=[{left:load("l1",default:good),right:load("r1",default:bad)},{left:peer,right:peer}]\nlet row2=[{left:load("l2",default:good),right:load("r2",default:other)},{left:peer,right:peer}]\nexit\n',
  ],
  [
    "shared-value-two-positions/load/depth0/flip0/reverse0",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet shared=load("shared",default:good)\nlet row0=[{left:shared,right:load("r0",default:good)},{left:peer,right:shared}]\nlet row1=[{left:shared,right:load("r1",default:bad)},{left:peer,right:shared}]\nlet row2=[{left:shared,right:load("r2",default:other)},{left:peer,right:shared}]\nexit\n',
  ],
  [
    "literal-beside-copy/load/depth0/flip0/reverse0",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet row0=[{own:load("c0",default:good),copy:alias},{own:alias,copy:peer}]\nlet row1=[{own:load("c1",default:bad),copy:alias},{own:alias,copy:peer}]\nlet row2=[{own:load("c2",default:other),copy:alias},{own:alias,copy:peer}]\nexit\n',
  ],
  [
    "dict-computed-key/load/depth0/flip0/reverse0",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet key:string="first"\nlet row0=dict{[key]:load("c0",default:good),second:peer}\nlet row1=dict{[key]:load("c1",default:bad),second:peer}\nlet row2=dict{[key]:load("c2",default:other),second:peer}\nexit\n',
  ],
  [
    "set-element/load/depth0/flip0/reverse0",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet row0=set[load("c0",default:good),peer]\nlet row1=set[load("c1",default:bad),peer]\nlet row2=set[load("c2",default:other),peer]\nexit\n',
  ],
  [
    "grafted-shared-source/load/depth0/flip0/reverse0",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet source={value:load("shared",default:good)}\nlet row0=[{at:source.value,own:load("c0",default:good)},{at:peer,own:peer}]\nlet row1=[{at:source.value,own:load("c1",default:bad)},{at:peer,own:peer}]\nlet row2=[{at:source.value,own:load("c2",default:other)},{at:peer,own:peer}]\nexit\n',
  ],
  [
    "three-contributors/load/depth0/flip0/reverse1",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet row2=[load("c2",default:other),peer]\nlet row1=[load("c1",default:bad),peer]\nlet row0=[load("c0",default:good),peer]\nexit\n',
  ],
  [
    "one-owner-two-paths/load/depth0/flip0/reverse1",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet row2=[{left:load("l2",default:good),right:load("r2",default:other)},{left:peer,right:peer}]\nlet row1=[{left:load("l1",default:good),right:load("r1",default:bad)},{left:peer,right:peer}]\nlet row0=[{left:load("l0",default:good),right:load("r0",default:good)},{left:peer,right:peer}]\nexit\n',
  ],
  [
    "shared-value-two-positions/load/depth0/flip0/reverse1",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet shared=load("shared",default:good)\nlet row2=[{left:shared,right:load("r2",default:other)},{left:peer,right:shared}]\nlet row1=[{left:shared,right:load("r1",default:bad)},{left:peer,right:shared}]\nlet row0=[{left:shared,right:load("r0",default:good)},{left:peer,right:shared}]\nexit\n',
  ],
  [
    "literal-beside-copy/load/depth0/flip0/reverse1",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet row2=[{own:load("c2",default:other),copy:alias},{own:alias,copy:peer}]\nlet row1=[{own:load("c1",default:bad),copy:alias},{own:alias,copy:peer}]\nlet row0=[{own:load("c0",default:good),copy:alias},{own:alias,copy:peer}]\nexit\n',
  ],
  [
    "dict-computed-key/load/depth0/flip0/reverse1",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet key:string="first"\nlet row2=dict{[key]:load("c2",default:other),second:peer}\nlet row1=dict{[key]:load("c1",default:bad),second:peer}\nlet row0=dict{[key]:load("c0",default:good),second:peer}\nexit\n',
  ],
  [
    "set-element/load/depth0/flip0/reverse1",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet row2=set[load("c2",default:other),peer]\nlet row1=set[load("c1",default:bad),peer]\nlet row0=set[load("c0",default:good),peer]\nexit\n',
  ],
  [
    "grafted-shared-source/load/depth0/flip0/reverse1",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet source={value:load("shared",default:good)}\nlet row2=[{at:source.value,own:load("c2",default:other)},{at:peer,own:peer}]\nlet row1=[{at:source.value,own:load("c1",default:bad)},{at:peer,own:peer}]\nlet row0=[{at:source.value,own:load("c0",default:good)},{at:peer,own:peer}]\nexit\n',
  ],
  [
    "three-contributors/load/depth0/flip1/reverse0",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet row0=[peer,load("c0",default:good)]\nlet row1=[peer,load("c1",default:bad)]\nlet row2=[peer,load("c2",default:other)]\nexit\n',
  ],
  [
    "one-owner-two-paths/load/depth0/flip1/reverse0",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet row0=[{left:peer,right:peer},{left:load("l0",default:good),right:load("r0",default:good)}]\nlet row1=[{left:peer,right:peer},{left:load("l1",default:good),right:load("r1",default:bad)}]\nlet row2=[{left:peer,right:peer},{left:load("l2",default:good),right:load("r2",default:other)}]\nexit\n',
  ],
  [
    "shared-value-two-positions/load/depth0/flip1/reverse0",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet shared=load("shared",default:good)\nlet row0=[{left:peer,right:shared},{left:shared,right:load("r0",default:good)}]\nlet row1=[{left:peer,right:shared},{left:shared,right:load("r1",default:bad)}]\nlet row2=[{left:peer,right:shared},{left:shared,right:load("r2",default:other)}]\nexit\n',
  ],
  [
    "literal-beside-copy/load/depth0/flip1/reverse0",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet row0=[{own:alias,copy:peer},{own:load("c0",default:good),copy:alias}]\nlet row1=[{own:alias,copy:peer},{own:load("c1",default:bad),copy:alias}]\nlet row2=[{own:alias,copy:peer},{own:load("c2",default:other),copy:alias}]\nexit\n',
  ],
  [
    "dict-computed-key/load/depth0/flip1/reverse0",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet key:string="first"\nlet row0=dict{[key]:peer,second:load("c0",default:good)}\nlet row1=dict{[key]:peer,second:load("c1",default:bad)}\nlet row2=dict{[key]:peer,second:load("c2",default:other)}\nexit\n',
  ],
  [
    "set-element/load/depth0/flip1/reverse0",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet row0=set[peer,load("c0",default:good)]\nlet row1=set[peer,load("c1",default:bad)]\nlet row2=set[peer,load("c2",default:other)]\nexit\n',
  ],
  [
    "grafted-shared-source/load/depth0/flip1/reverse0",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet source={value:load("shared",default:good)}\nlet row0=[{at:peer,own:peer},{at:source.value,own:load("c0",default:good)}]\nlet row1=[{at:peer,own:peer},{at:source.value,own:load("c1",default:bad)}]\nlet row2=[{at:peer,own:peer},{at:source.value,own:load("c2",default:other)}]\nexit\n',
  ],
  [
    "three-contributors/load/depth0/flip1/reverse1",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet row2=[peer,load("c2",default:other)]\nlet row1=[peer,load("c1",default:bad)]\nlet row0=[peer,load("c0",default:good)]\nexit\n',
  ],
  [
    "one-owner-two-paths/load/depth0/flip1/reverse1",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet row2=[{left:peer,right:peer},{left:load("l2",default:good),right:load("r2",default:other)}]\nlet row1=[{left:peer,right:peer},{left:load("l1",default:good),right:load("r1",default:bad)}]\nlet row0=[{left:peer,right:peer},{left:load("l0",default:good),right:load("r0",default:good)}]\nexit\n',
  ],
  [
    "shared-value-two-positions/load/depth0/flip1/reverse1",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet shared=load("shared",default:good)\nlet row2=[{left:peer,right:shared},{left:shared,right:load("r2",default:other)}]\nlet row1=[{left:peer,right:shared},{left:shared,right:load("r1",default:bad)}]\nlet row0=[{left:peer,right:shared},{left:shared,right:load("r0",default:good)}]\nexit\n',
  ],
  [
    "literal-beside-copy/load/depth0/flip1/reverse1",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet row2=[{own:alias,copy:peer},{own:load("c2",default:other),copy:alias}]\nlet row1=[{own:alias,copy:peer},{own:load("c1",default:bad),copy:alias}]\nlet row0=[{own:alias,copy:peer},{own:load("c0",default:good),copy:alias}]\nexit\n',
  ],
  [
    "dict-computed-key/load/depth0/flip1/reverse1",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet key:string="first"\nlet row2=dict{[key]:peer,second:load("c2",default:other)}\nlet row1=dict{[key]:peer,second:load("c1",default:bad)}\nlet row0=dict{[key]:peer,second:load("c0",default:good)}\nexit\n',
  ],
  [
    "set-element/load/depth0/flip1/reverse1",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet row2=set[peer,load("c2",default:other)]\nlet row1=set[peer,load("c1",default:bad)]\nlet row0=set[peer,load("c0",default:good)]\nexit\n',
  ],
  [
    "grafted-shared-source/load/depth0/flip1/reverse1",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet source={value:load("shared",default:good)}\nlet row2=[{at:peer,own:peer},{at:source.value,own:load("c2",default:other)}]\nlet row1=[{at:peer,own:peer},{at:source.value,own:load("c1",default:bad)}]\nlet row0=[{at:peer,own:peer},{at:source.value,own:load("c0",default:good)}]\nexit\n',
  ],
  [
    "three-contributors/load/depth2/flip0/reverse0",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet row0=[load("c0",default:good),peer]\nlet row1=[load("c1",default:bad),peer]\nlet row2=[load("c2",default:other),peer]\nexit\n',
  ],
  [
    "one-owner-two-paths/load/depth2/flip0/reverse0",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet row0=[{left:load("l0",default:good),right:load("r0",default:good)},{left:peer,right:peer}]\nlet row1=[{left:load("l1",default:good),right:load("r1",default:bad)},{left:peer,right:peer}]\nlet row2=[{left:load("l2",default:good),right:load("r2",default:other)},{left:peer,right:peer}]\nexit\n',
  ],
  [
    "shared-value-two-positions/load/depth2/flip0/reverse0",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet shared=load("shared",default:good)\nlet row0=[{left:shared,right:load("r0",default:good)},{left:peer,right:shared}]\nlet row1=[{left:shared,right:load("r1",default:bad)},{left:peer,right:shared}]\nlet row2=[{left:shared,right:load("r2",default:other)},{left:peer,right:shared}]\nexit\n',
  ],
  [
    "literal-beside-copy/load/depth2/flip0/reverse0",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet row0=[{own:load("c0",default:good),copy:alias},{own:alias,copy:peer}]\nlet row1=[{own:load("c1",default:bad),copy:alias},{own:alias,copy:peer}]\nlet row2=[{own:load("c2",default:other),copy:alias},{own:alias,copy:peer}]\nexit\n',
  ],
  [
    "dict-computed-key/load/depth2/flip0/reverse0",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet key:string="first"\nlet row0=dict{[key]:load("c0",default:good),second:peer}\nlet row1=dict{[key]:load("c1",default:bad),second:peer}\nlet row2=dict{[key]:load("c2",default:other),second:peer}\nexit\n',
  ],
  [
    "set-element/load/depth2/flip0/reverse0",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet row0=set[load("c0",default:good),peer]\nlet row1=set[load("c1",default:bad),peer]\nlet row2=set[load("c2",default:other),peer]\nexit\n',
  ],
  [
    "grafted-shared-source/load/depth2/flip0/reverse0",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet source={value:load("shared",default:good)}\nlet row0=[{at:source.value,own:load("c0",default:good)},{at:peer,own:peer}]\nlet row1=[{at:source.value,own:load("c1",default:bad)},{at:peer,own:peer}]\nlet row2=[{at:source.value,own:load("c2",default:other)},{at:peer,own:peer}]\nexit\n',
  ],
  [
    "three-contributors/load/depth2/flip0/reverse1",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet row2=[load("c2",default:other),peer]\nlet row1=[load("c1",default:bad),peer]\nlet row0=[load("c0",default:good),peer]\nexit\n',
  ],
  [
    "one-owner-two-paths/load/depth2/flip0/reverse1",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet row2=[{left:load("l2",default:good),right:load("r2",default:other)},{left:peer,right:peer}]\nlet row1=[{left:load("l1",default:good),right:load("r1",default:bad)},{left:peer,right:peer}]\nlet row0=[{left:load("l0",default:good),right:load("r0",default:good)},{left:peer,right:peer}]\nexit\n',
  ],
  [
    "shared-value-two-positions/load/depth2/flip0/reverse1",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet shared=load("shared",default:good)\nlet row2=[{left:shared,right:load("r2",default:other)},{left:peer,right:shared}]\nlet row1=[{left:shared,right:load("r1",default:bad)},{left:peer,right:shared}]\nlet row0=[{left:shared,right:load("r0",default:good)},{left:peer,right:shared}]\nexit\n',
  ],
  [
    "literal-beside-copy/load/depth2/flip0/reverse1",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet row2=[{own:load("c2",default:other),copy:alias},{own:alias,copy:peer}]\nlet row1=[{own:load("c1",default:bad),copy:alias},{own:alias,copy:peer}]\nlet row0=[{own:load("c0",default:good),copy:alias},{own:alias,copy:peer}]\nexit\n',
  ],
  [
    "dict-computed-key/load/depth2/flip0/reverse1",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet key:string="first"\nlet row2=dict{[key]:load("c2",default:other),second:peer}\nlet row1=dict{[key]:load("c1",default:bad),second:peer}\nlet row0=dict{[key]:load("c0",default:good),second:peer}\nexit\n',
  ],
  [
    "set-element/load/depth2/flip0/reverse1",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet row2=set[load("c2",default:other),peer]\nlet row1=set[load("c1",default:bad),peer]\nlet row0=set[load("c0",default:good),peer]\nexit\n',
  ],
  [
    "grafted-shared-source/load/depth2/flip0/reverse1",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet source={value:load("shared",default:good)}\nlet row2=[{at:source.value,own:load("c2",default:other)},{at:peer,own:peer}]\nlet row1=[{at:source.value,own:load("c1",default:bad)},{at:peer,own:peer}]\nlet row0=[{at:source.value,own:load("c0",default:good)},{at:peer,own:peer}]\nexit\n',
  ],
  [
    "three-contributors/load/depth2/flip1/reverse0",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet row0=[peer,load("c0",default:good)]\nlet row1=[peer,load("c1",default:bad)]\nlet row2=[peer,load("c2",default:other)]\nexit\n',
  ],
  [
    "one-owner-two-paths/load/depth2/flip1/reverse0",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet row0=[{left:peer,right:peer},{left:load("l0",default:good),right:load("r0",default:good)}]\nlet row1=[{left:peer,right:peer},{left:load("l1",default:good),right:load("r1",default:bad)}]\nlet row2=[{left:peer,right:peer},{left:load("l2",default:good),right:load("r2",default:other)}]\nexit\n',
  ],
  [
    "shared-value-two-positions/load/depth2/flip1/reverse0",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet shared=load("shared",default:good)\nlet row0=[{left:peer,right:shared},{left:shared,right:load("r0",default:good)}]\nlet row1=[{left:peer,right:shared},{left:shared,right:load("r1",default:bad)}]\nlet row2=[{left:peer,right:shared},{left:shared,right:load("r2",default:other)}]\nexit\n',
  ],
  [
    "literal-beside-copy/load/depth2/flip1/reverse0",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet row0=[{own:alias,copy:peer},{own:load("c0",default:good),copy:alias}]\nlet row1=[{own:alias,copy:peer},{own:load("c1",default:bad),copy:alias}]\nlet row2=[{own:alias,copy:peer},{own:load("c2",default:other),copy:alias}]\nexit\n',
  ],
  [
    "dict-computed-key/load/depth2/flip1/reverse0",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet key:string="first"\nlet row0=dict{[key]:peer,second:load("c0",default:good)}\nlet row1=dict{[key]:peer,second:load("c1",default:bad)}\nlet row2=dict{[key]:peer,second:load("c2",default:other)}\nexit\n',
  ],
  [
    "set-element/load/depth2/flip1/reverse0",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet row0=set[peer,load("c0",default:good)]\nlet row1=set[peer,load("c1",default:bad)]\nlet row2=set[peer,load("c2",default:other)]\nexit\n',
  ],
  [
    "grafted-shared-source/load/depth2/flip1/reverse0",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet source={value:load("shared",default:good)}\nlet row0=[{at:peer,own:peer},{at:source.value,own:load("c0",default:good)}]\nlet row1=[{at:peer,own:peer},{at:source.value,own:load("c1",default:bad)}]\nlet row2=[{at:peer,own:peer},{at:source.value,own:load("c2",default:other)}]\nexit\n',
  ],
  [
    "three-contributors/load/depth2/flip1/reverse1",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet row2=[peer,load("c2",default:other)]\nlet row1=[peer,load("c1",default:bad)]\nlet row0=[peer,load("c0",default:good)]\nexit\n',
  ],
  [
    "one-owner-two-paths/load/depth2/flip1/reverse1",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet row2=[{left:peer,right:peer},{left:load("l2",default:good),right:load("r2",default:other)}]\nlet row1=[{left:peer,right:peer},{left:load("l1",default:good),right:load("r1",default:bad)}]\nlet row0=[{left:peer,right:peer},{left:load("l0",default:good),right:load("r0",default:good)}]\nexit\n',
  ],
  [
    "shared-value-two-positions/load/depth2/flip1/reverse1",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet shared=load("shared",default:good)\nlet row2=[{left:peer,right:shared},{left:shared,right:load("r2",default:other)}]\nlet row1=[{left:peer,right:shared},{left:shared,right:load("r1",default:bad)}]\nlet row0=[{left:peer,right:shared},{left:shared,right:load("r0",default:good)}]\nexit\n',
  ],
  [
    "literal-beside-copy/load/depth2/flip1/reverse1",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet row2=[{own:alias,copy:peer},{own:load("c2",default:other),copy:alias}]\nlet row1=[{own:alias,copy:peer},{own:load("c1",default:bad),copy:alias}]\nlet row0=[{own:alias,copy:peer},{own:load("c0",default:good),copy:alias}]\nexit\n',
  ],
  [
    "dict-computed-key/load/depth2/flip1/reverse1",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet key:string="first"\nlet row2=dict{[key]:peer,second:load("c2",default:other)}\nlet row1=dict{[key]:peer,second:load("c1",default:bad)}\nlet row0=dict{[key]:peer,second:load("c0",default:good)}\nexit\n',
  ],
  [
    "set-element/load/depth2/flip1/reverse1",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet row2=set[peer,load("c2",default:other)]\nlet row1=set[peer,load("c1",default:bad)]\nlet row0=set[peer,load("c0",default:good)]\nexit\n',
  ],
  [
    "grafted-shared-source/load/depth2/flip1/reverse1",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet source={value:load("shared",default:good)}\nlet row2=[{at:peer,own:peer},{at:source.value,own:load("c2",default:other)}]\nlet row1=[{at:peer,own:peer},{at:source.value,own:load("c1",default:bad)}]\nlet row0=[{at:peer,own:peer},{at:source.value,own:load("c0",default:good)}]\nexit\n',
  ],
  [
    "three-contributors/fromJson/depth0/flip0/reverse0",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet row0=[fromJson(hostValue,default:good,files:false),peer]\nlet row1=[fromJson(hostValue,default:bad,files:false),peer]\nlet row2=[fromJson(hostValue,default:other,files:false),peer]\nexit\n',
  ],
  [
    "one-owner-two-paths/fromJson/depth0/flip0/reverse0",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet row0=[{left:fromJson(hostValue,default:good,files:false),right:fromJson(hostValue,default:good,files:false)},{left:peer,right:peer}]\nlet row1=[{left:fromJson(hostValue,default:good,files:false),right:fromJson(hostValue,default:bad,files:false)},{left:peer,right:peer}]\nlet row2=[{left:fromJson(hostValue,default:good,files:false),right:fromJson(hostValue,default:other,files:false)},{left:peer,right:peer}]\nexit\n',
  ],
  [
    "shared-value-two-positions/fromJson/depth0/flip0/reverse0",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet shared=fromJson(hostValue,default:good,files:false)\nlet row0=[{left:shared,right:fromJson(hostValue,default:good,files:false)},{left:peer,right:shared}]\nlet row1=[{left:shared,right:fromJson(hostValue,default:bad,files:false)},{left:peer,right:shared}]\nlet row2=[{left:shared,right:fromJson(hostValue,default:other,files:false)},{left:peer,right:shared}]\nexit\n',
  ],
  [
    "literal-beside-copy/fromJson/depth0/flip0/reverse0",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet row0=[{own:fromJson(hostValue,default:good,files:false),copy:alias},{own:alias,copy:peer}]\nlet row1=[{own:fromJson(hostValue,default:bad,files:false),copy:alias},{own:alias,copy:peer}]\nlet row2=[{own:fromJson(hostValue,default:other,files:false),copy:alias},{own:alias,copy:peer}]\nexit\n',
  ],
  [
    "dict-computed-key/fromJson/depth0/flip0/reverse0",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet key:string="first"\nlet row0=dict{[key]:fromJson(hostValue,default:good,files:false),second:peer}\nlet row1=dict{[key]:fromJson(hostValue,default:bad,files:false),second:peer}\nlet row2=dict{[key]:fromJson(hostValue,default:other,files:false),second:peer}\nexit\n',
  ],
  [
    "set-element/fromJson/depth0/flip0/reverse0",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet row0=set[fromJson(hostValue,default:good,files:false),peer]\nlet row1=set[fromJson(hostValue,default:bad,files:false),peer]\nlet row2=set[fromJson(hostValue,default:other,files:false),peer]\nexit\n',
  ],
  [
    "grafted-shared-source/fromJson/depth0/flip0/reverse0",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet source={value:fromJson(hostValue,default:good,files:false)}\nlet row0=[{at:source.value,own:fromJson(hostValue,default:good,files:false)},{at:peer,own:peer}]\nlet row1=[{at:source.value,own:fromJson(hostValue,default:bad,files:false)},{at:peer,own:peer}]\nlet row2=[{at:source.value,own:fromJson(hostValue,default:other,files:false)},{at:peer,own:peer}]\nexit\n',
  ],
  [
    "three-contributors/fromJson/depth0/flip0/reverse1",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet row2=[fromJson(hostValue,default:other,files:false),peer]\nlet row1=[fromJson(hostValue,default:bad,files:false),peer]\nlet row0=[fromJson(hostValue,default:good,files:false),peer]\nexit\n',
  ],
  [
    "one-owner-two-paths/fromJson/depth0/flip0/reverse1",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet row2=[{left:fromJson(hostValue,default:good,files:false),right:fromJson(hostValue,default:other,files:false)},{left:peer,right:peer}]\nlet row1=[{left:fromJson(hostValue,default:good,files:false),right:fromJson(hostValue,default:bad,files:false)},{left:peer,right:peer}]\nlet row0=[{left:fromJson(hostValue,default:good,files:false),right:fromJson(hostValue,default:good,files:false)},{left:peer,right:peer}]\nexit\n',
  ],
  [
    "shared-value-two-positions/fromJson/depth0/flip0/reverse1",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet shared=fromJson(hostValue,default:good,files:false)\nlet row2=[{left:shared,right:fromJson(hostValue,default:other,files:false)},{left:peer,right:shared}]\nlet row1=[{left:shared,right:fromJson(hostValue,default:bad,files:false)},{left:peer,right:shared}]\nlet row0=[{left:shared,right:fromJson(hostValue,default:good,files:false)},{left:peer,right:shared}]\nexit\n',
  ],
  [
    "literal-beside-copy/fromJson/depth0/flip0/reverse1",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet row2=[{own:fromJson(hostValue,default:other,files:false),copy:alias},{own:alias,copy:peer}]\nlet row1=[{own:fromJson(hostValue,default:bad,files:false),copy:alias},{own:alias,copy:peer}]\nlet row0=[{own:fromJson(hostValue,default:good,files:false),copy:alias},{own:alias,copy:peer}]\nexit\n',
  ],
  [
    "dict-computed-key/fromJson/depth0/flip0/reverse1",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet key:string="first"\nlet row2=dict{[key]:fromJson(hostValue,default:other,files:false),second:peer}\nlet row1=dict{[key]:fromJson(hostValue,default:bad,files:false),second:peer}\nlet row0=dict{[key]:fromJson(hostValue,default:good,files:false),second:peer}\nexit\n',
  ],
  [
    "set-element/fromJson/depth0/flip0/reverse1",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet row2=set[fromJson(hostValue,default:other,files:false),peer]\nlet row1=set[fromJson(hostValue,default:bad,files:false),peer]\nlet row0=set[fromJson(hostValue,default:good,files:false),peer]\nexit\n',
  ],
  [
    "grafted-shared-source/fromJson/depth0/flip0/reverse1",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet source={value:fromJson(hostValue,default:good,files:false)}\nlet row2=[{at:source.value,own:fromJson(hostValue,default:other,files:false)},{at:peer,own:peer}]\nlet row1=[{at:source.value,own:fromJson(hostValue,default:bad,files:false)},{at:peer,own:peer}]\nlet row0=[{at:source.value,own:fromJson(hostValue,default:good,files:false)},{at:peer,own:peer}]\nexit\n',
  ],
  [
    "three-contributors/fromJson/depth0/flip1/reverse0",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet row0=[peer,fromJson(hostValue,default:good,files:false)]\nlet row1=[peer,fromJson(hostValue,default:bad,files:false)]\nlet row2=[peer,fromJson(hostValue,default:other,files:false)]\nexit\n',
  ],
  [
    "one-owner-two-paths/fromJson/depth0/flip1/reverse0",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet row0=[{left:peer,right:peer},{left:fromJson(hostValue,default:good,files:false),right:fromJson(hostValue,default:good,files:false)}]\nlet row1=[{left:peer,right:peer},{left:fromJson(hostValue,default:good,files:false),right:fromJson(hostValue,default:bad,files:false)}]\nlet row2=[{left:peer,right:peer},{left:fromJson(hostValue,default:good,files:false),right:fromJson(hostValue,default:other,files:false)}]\nexit\n',
  ],
  [
    "shared-value-two-positions/fromJson/depth0/flip1/reverse0",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet shared=fromJson(hostValue,default:good,files:false)\nlet row0=[{left:peer,right:shared},{left:shared,right:fromJson(hostValue,default:good,files:false)}]\nlet row1=[{left:peer,right:shared},{left:shared,right:fromJson(hostValue,default:bad,files:false)}]\nlet row2=[{left:peer,right:shared},{left:shared,right:fromJson(hostValue,default:other,files:false)}]\nexit\n',
  ],
  [
    "literal-beside-copy/fromJson/depth0/flip1/reverse0",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet row0=[{own:alias,copy:peer},{own:fromJson(hostValue,default:good,files:false),copy:alias}]\nlet row1=[{own:alias,copy:peer},{own:fromJson(hostValue,default:bad,files:false),copy:alias}]\nlet row2=[{own:alias,copy:peer},{own:fromJson(hostValue,default:other,files:false),copy:alias}]\nexit\n',
  ],
  [
    "dict-computed-key/fromJson/depth0/flip1/reverse0",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet key:string="first"\nlet row0=dict{[key]:peer,second:fromJson(hostValue,default:good,files:false)}\nlet row1=dict{[key]:peer,second:fromJson(hostValue,default:bad,files:false)}\nlet row2=dict{[key]:peer,second:fromJson(hostValue,default:other,files:false)}\nexit\n',
  ],
  [
    "set-element/fromJson/depth0/flip1/reverse0",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet row0=set[peer,fromJson(hostValue,default:good,files:false)]\nlet row1=set[peer,fromJson(hostValue,default:bad,files:false)]\nlet row2=set[peer,fromJson(hostValue,default:other,files:false)]\nexit\n',
  ],
  [
    "grafted-shared-source/fromJson/depth0/flip1/reverse0",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet source={value:fromJson(hostValue,default:good,files:false)}\nlet row0=[{at:peer,own:peer},{at:source.value,own:fromJson(hostValue,default:good,files:false)}]\nlet row1=[{at:peer,own:peer},{at:source.value,own:fromJson(hostValue,default:bad,files:false)}]\nlet row2=[{at:peer,own:peer},{at:source.value,own:fromJson(hostValue,default:other,files:false)}]\nexit\n',
  ],
  [
    "three-contributors/fromJson/depth0/flip1/reverse1",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet row2=[peer,fromJson(hostValue,default:other,files:false)]\nlet row1=[peer,fromJson(hostValue,default:bad,files:false)]\nlet row0=[peer,fromJson(hostValue,default:good,files:false)]\nexit\n',
  ],
  [
    "one-owner-two-paths/fromJson/depth0/flip1/reverse1",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet row2=[{left:peer,right:peer},{left:fromJson(hostValue,default:good,files:false),right:fromJson(hostValue,default:other,files:false)}]\nlet row1=[{left:peer,right:peer},{left:fromJson(hostValue,default:good,files:false),right:fromJson(hostValue,default:bad,files:false)}]\nlet row0=[{left:peer,right:peer},{left:fromJson(hostValue,default:good,files:false),right:fromJson(hostValue,default:good,files:false)}]\nexit\n',
  ],
  [
    "shared-value-two-positions/fromJson/depth0/flip1/reverse1",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet shared=fromJson(hostValue,default:good,files:false)\nlet row2=[{left:peer,right:shared},{left:shared,right:fromJson(hostValue,default:other,files:false)}]\nlet row1=[{left:peer,right:shared},{left:shared,right:fromJson(hostValue,default:bad,files:false)}]\nlet row0=[{left:peer,right:shared},{left:shared,right:fromJson(hostValue,default:good,files:false)}]\nexit\n',
  ],
  [
    "literal-beside-copy/fromJson/depth0/flip1/reverse1",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet row2=[{own:alias,copy:peer},{own:fromJson(hostValue,default:other,files:false),copy:alias}]\nlet row1=[{own:alias,copy:peer},{own:fromJson(hostValue,default:bad,files:false),copy:alias}]\nlet row0=[{own:alias,copy:peer},{own:fromJson(hostValue,default:good,files:false),copy:alias}]\nexit\n',
  ],
  [
    "dict-computed-key/fromJson/depth0/flip1/reverse1",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet key:string="first"\nlet row2=dict{[key]:peer,second:fromJson(hostValue,default:other,files:false)}\nlet row1=dict{[key]:peer,second:fromJson(hostValue,default:bad,files:false)}\nlet row0=dict{[key]:peer,second:fromJson(hostValue,default:good,files:false)}\nexit\n',
  ],
  [
    "set-element/fromJson/depth0/flip1/reverse1",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet row2=set[peer,fromJson(hostValue,default:other,files:false)]\nlet row1=set[peer,fromJson(hostValue,default:bad,files:false)]\nlet row0=set[peer,fromJson(hostValue,default:good,files:false)]\nexit\n',
  ],
  [
    "grafted-shared-source/fromJson/depth0/flip1/reverse1",
    'let atom:integer=13\nlet peer={x:atom}\nlet good={x:1}\nlet bad={x:"wrong"}\nlet other={x:true}\nlet alias=peer\nlet source={value:fromJson(hostValue,default:good,files:false)}\nlet row2=[{at:peer,own:peer},{at:source.value,own:fromJson(hostValue,default:other,files:false)}]\nlet row1=[{at:peer,own:peer},{at:source.value,own:fromJson(hostValue,default:bad,files:false)}]\nlet row0=[{at:peer,own:peer},{at:source.value,own:fromJson(hostValue,default:good,files:false)}]\nexit\n',
  ],
  [
    "three-contributors/fromJson/depth2/flip0/reverse0",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet row0=[fromJson(hostValue,default:good,files:false),peer]\nlet row1=[fromJson(hostValue,default:bad,files:false),peer]\nlet row2=[fromJson(hostValue,default:other,files:false),peer]\nexit\n',
  ],
  [
    "one-owner-two-paths/fromJson/depth2/flip0/reverse0",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet row0=[{left:fromJson(hostValue,default:good,files:false),right:fromJson(hostValue,default:good,files:false)},{left:peer,right:peer}]\nlet row1=[{left:fromJson(hostValue,default:good,files:false),right:fromJson(hostValue,default:bad,files:false)},{left:peer,right:peer}]\nlet row2=[{left:fromJson(hostValue,default:good,files:false),right:fromJson(hostValue,default:other,files:false)},{left:peer,right:peer}]\nexit\n',
  ],
  [
    "shared-value-two-positions/fromJson/depth2/flip0/reverse0",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet shared=fromJson(hostValue,default:good,files:false)\nlet row0=[{left:shared,right:fromJson(hostValue,default:good,files:false)},{left:peer,right:shared}]\nlet row1=[{left:shared,right:fromJson(hostValue,default:bad,files:false)},{left:peer,right:shared}]\nlet row2=[{left:shared,right:fromJson(hostValue,default:other,files:false)},{left:peer,right:shared}]\nexit\n',
  ],
  [
    "literal-beside-copy/fromJson/depth2/flip0/reverse0",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet row0=[{own:fromJson(hostValue,default:good,files:false),copy:alias},{own:alias,copy:peer}]\nlet row1=[{own:fromJson(hostValue,default:bad,files:false),copy:alias},{own:alias,copy:peer}]\nlet row2=[{own:fromJson(hostValue,default:other,files:false),copy:alias},{own:alias,copy:peer}]\nexit\n',
  ],
  [
    "dict-computed-key/fromJson/depth2/flip0/reverse0",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet key:string="first"\nlet row0=dict{[key]:fromJson(hostValue,default:good,files:false),second:peer}\nlet row1=dict{[key]:fromJson(hostValue,default:bad,files:false),second:peer}\nlet row2=dict{[key]:fromJson(hostValue,default:other,files:false),second:peer}\nexit\n',
  ],
  [
    "set-element/fromJson/depth2/flip0/reverse0",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet row0=set[fromJson(hostValue,default:good,files:false),peer]\nlet row1=set[fromJson(hostValue,default:bad,files:false),peer]\nlet row2=set[fromJson(hostValue,default:other,files:false),peer]\nexit\n',
  ],
  [
    "grafted-shared-source/fromJson/depth2/flip0/reverse0",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet source={value:fromJson(hostValue,default:good,files:false)}\nlet row0=[{at:source.value,own:fromJson(hostValue,default:good,files:false)},{at:peer,own:peer}]\nlet row1=[{at:source.value,own:fromJson(hostValue,default:bad,files:false)},{at:peer,own:peer}]\nlet row2=[{at:source.value,own:fromJson(hostValue,default:other,files:false)},{at:peer,own:peer}]\nexit\n',
  ],
  [
    "three-contributors/fromJson/depth2/flip0/reverse1",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet row2=[fromJson(hostValue,default:other,files:false),peer]\nlet row1=[fromJson(hostValue,default:bad,files:false),peer]\nlet row0=[fromJson(hostValue,default:good,files:false),peer]\nexit\n',
  ],
  [
    "one-owner-two-paths/fromJson/depth2/flip0/reverse1",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet row2=[{left:fromJson(hostValue,default:good,files:false),right:fromJson(hostValue,default:other,files:false)},{left:peer,right:peer}]\nlet row1=[{left:fromJson(hostValue,default:good,files:false),right:fromJson(hostValue,default:bad,files:false)},{left:peer,right:peer}]\nlet row0=[{left:fromJson(hostValue,default:good,files:false),right:fromJson(hostValue,default:good,files:false)},{left:peer,right:peer}]\nexit\n',
  ],
  [
    "shared-value-two-positions/fromJson/depth2/flip0/reverse1",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet shared=fromJson(hostValue,default:good,files:false)\nlet row2=[{left:shared,right:fromJson(hostValue,default:other,files:false)},{left:peer,right:shared}]\nlet row1=[{left:shared,right:fromJson(hostValue,default:bad,files:false)},{left:peer,right:shared}]\nlet row0=[{left:shared,right:fromJson(hostValue,default:good,files:false)},{left:peer,right:shared}]\nexit\n',
  ],
  [
    "literal-beside-copy/fromJson/depth2/flip0/reverse1",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet row2=[{own:fromJson(hostValue,default:other,files:false),copy:alias},{own:alias,copy:peer}]\nlet row1=[{own:fromJson(hostValue,default:bad,files:false),copy:alias},{own:alias,copy:peer}]\nlet row0=[{own:fromJson(hostValue,default:good,files:false),copy:alias},{own:alias,copy:peer}]\nexit\n',
  ],
  [
    "dict-computed-key/fromJson/depth2/flip0/reverse1",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet key:string="first"\nlet row2=dict{[key]:fromJson(hostValue,default:other,files:false),second:peer}\nlet row1=dict{[key]:fromJson(hostValue,default:bad,files:false),second:peer}\nlet row0=dict{[key]:fromJson(hostValue,default:good,files:false),second:peer}\nexit\n',
  ],
  [
    "set-element/fromJson/depth2/flip0/reverse1",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet row2=set[fromJson(hostValue,default:other,files:false),peer]\nlet row1=set[fromJson(hostValue,default:bad,files:false),peer]\nlet row0=set[fromJson(hostValue,default:good,files:false),peer]\nexit\n',
  ],
  [
    "grafted-shared-source/fromJson/depth2/flip0/reverse1",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet source={value:fromJson(hostValue,default:good,files:false)}\nlet row2=[{at:source.value,own:fromJson(hostValue,default:other,files:false)},{at:peer,own:peer}]\nlet row1=[{at:source.value,own:fromJson(hostValue,default:bad,files:false)},{at:peer,own:peer}]\nlet row0=[{at:source.value,own:fromJson(hostValue,default:good,files:false)},{at:peer,own:peer}]\nexit\n',
  ],
  [
    "three-contributors/fromJson/depth2/flip1/reverse0",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet row0=[peer,fromJson(hostValue,default:good,files:false)]\nlet row1=[peer,fromJson(hostValue,default:bad,files:false)]\nlet row2=[peer,fromJson(hostValue,default:other,files:false)]\nexit\n',
  ],
  [
    "one-owner-two-paths/fromJson/depth2/flip1/reverse0",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet row0=[{left:peer,right:peer},{left:fromJson(hostValue,default:good,files:false),right:fromJson(hostValue,default:good,files:false)}]\nlet row1=[{left:peer,right:peer},{left:fromJson(hostValue,default:good,files:false),right:fromJson(hostValue,default:bad,files:false)}]\nlet row2=[{left:peer,right:peer},{left:fromJson(hostValue,default:good,files:false),right:fromJson(hostValue,default:other,files:false)}]\nexit\n',
  ],
  [
    "shared-value-two-positions/fromJson/depth2/flip1/reverse0",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet shared=fromJson(hostValue,default:good,files:false)\nlet row0=[{left:peer,right:shared},{left:shared,right:fromJson(hostValue,default:good,files:false)}]\nlet row1=[{left:peer,right:shared},{left:shared,right:fromJson(hostValue,default:bad,files:false)}]\nlet row2=[{left:peer,right:shared},{left:shared,right:fromJson(hostValue,default:other,files:false)}]\nexit\n',
  ],
  [
    "literal-beside-copy/fromJson/depth2/flip1/reverse0",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet row0=[{own:alias,copy:peer},{own:fromJson(hostValue,default:good,files:false),copy:alias}]\nlet row1=[{own:alias,copy:peer},{own:fromJson(hostValue,default:bad,files:false),copy:alias}]\nlet row2=[{own:alias,copy:peer},{own:fromJson(hostValue,default:other,files:false),copy:alias}]\nexit\n',
  ],
  [
    "dict-computed-key/fromJson/depth2/flip1/reverse0",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet key:string="first"\nlet row0=dict{[key]:peer,second:fromJson(hostValue,default:good,files:false)}\nlet row1=dict{[key]:peer,second:fromJson(hostValue,default:bad,files:false)}\nlet row2=dict{[key]:peer,second:fromJson(hostValue,default:other,files:false)}\nexit\n',
  ],
  [
    "set-element/fromJson/depth2/flip1/reverse0",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet row0=set[peer,fromJson(hostValue,default:good,files:false)]\nlet row1=set[peer,fromJson(hostValue,default:bad,files:false)]\nlet row2=set[peer,fromJson(hostValue,default:other,files:false)]\nexit\n',
  ],
  [
    "grafted-shared-source/fromJson/depth2/flip1/reverse0",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet source={value:fromJson(hostValue,default:good,files:false)}\nlet row0=[{at:peer,own:peer},{at:source.value,own:fromJson(hostValue,default:good,files:false)}]\nlet row1=[{at:peer,own:peer},{at:source.value,own:fromJson(hostValue,default:bad,files:false)}]\nlet row2=[{at:peer,own:peer},{at:source.value,own:fromJson(hostValue,default:other,files:false)}]\nexit\n',
  ],
  [
    "three-contributors/fromJson/depth2/flip1/reverse1",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet row2=[peer,fromJson(hostValue,default:other,files:false)]\nlet row1=[peer,fromJson(hostValue,default:bad,files:false)]\nlet row0=[peer,fromJson(hostValue,default:good,files:false)]\nexit\n',
  ],
  [
    "one-owner-two-paths/fromJson/depth2/flip1/reverse1",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet row2=[{left:peer,right:peer},{left:fromJson(hostValue,default:good,files:false),right:fromJson(hostValue,default:other,files:false)}]\nlet row1=[{left:peer,right:peer},{left:fromJson(hostValue,default:good,files:false),right:fromJson(hostValue,default:bad,files:false)}]\nlet row0=[{left:peer,right:peer},{left:fromJson(hostValue,default:good,files:false),right:fromJson(hostValue,default:good,files:false)}]\nexit\n',
  ],
  [
    "shared-value-two-positions/fromJson/depth2/flip1/reverse1",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet shared=fromJson(hostValue,default:good,files:false)\nlet row2=[{left:peer,right:shared},{left:shared,right:fromJson(hostValue,default:other,files:false)}]\nlet row1=[{left:peer,right:shared},{left:shared,right:fromJson(hostValue,default:bad,files:false)}]\nlet row0=[{left:peer,right:shared},{left:shared,right:fromJson(hostValue,default:good,files:false)}]\nexit\n',
  ],
  [
    "literal-beside-copy/fromJson/depth2/flip1/reverse1",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet row2=[{own:alias,copy:peer},{own:fromJson(hostValue,default:other,files:false),copy:alias}]\nlet row1=[{own:alias,copy:peer},{own:fromJson(hostValue,default:bad,files:false),copy:alias}]\nlet row0=[{own:alias,copy:peer},{own:fromJson(hostValue,default:good,files:false),copy:alias}]\nexit\n',
  ],
  [
    "dict-computed-key/fromJson/depth2/flip1/reverse1",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet key:string="first"\nlet row2=dict{[key]:peer,second:fromJson(hostValue,default:other,files:false)}\nlet row1=dict{[key]:peer,second:fromJson(hostValue,default:bad,files:false)}\nlet row0=dict{[key]:peer,second:fromJson(hostValue,default:good,files:false)}\nexit\n',
  ],
  [
    "set-element/fromJson/depth2/flip1/reverse1",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet row2=set[peer,fromJson(hostValue,default:other,files:false)]\nlet row1=set[peer,fromJson(hostValue,default:bad,files:false)]\nlet row0=set[peer,fromJson(hostValue,default:good,files:false)]\nexit\n',
  ],
  [
    "grafted-shared-source/fromJson/depth2/flip1/reverse1",
    'let atom:integer=13\nlet peer={nest:{deep:{x:atom}}}\nlet good={nest:{deep:{x:1}}}\nlet bad={nest:{deep:{x:"wrong"}}}\nlet other={nest:{deep:{x:true}}}\nlet alias=peer\nlet source={value:fromJson(hostValue,default:good,files:false)}\nlet row2=[{at:peer,own:peer},{at:source.value,own:fromJson(hostValue,default:other,files:false)}]\nlet row1=[{at:peer,own:peer},{at:source.value,own:fromJson(hostValue,default:bad,files:false)}]\nlet row0=[{at:peer,own:peer},{at:source.value,own:fromJson(hostValue,default:good,files:false)}]\nexit\n',
  ],
];

// the globals the recorded run passed
export const globals = ["hostValue", "hostInit"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "env TOUCH_ORACLE=0 node probe/keptseq2.mjs <trees>/main cases/own.json out/own-main.jsonl",
      "R/astra-m4-i1188-pr-review-r2-evidence/full-evidence.tar.gz!out/own-main.status.json:1",
    ],
  ],
  sources: 112,
  sha256: "36688a8d92494f1b8742a430e9822a64a85cc0be30c45aaecd790b1468e86a8d",
};
