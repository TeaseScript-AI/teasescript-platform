// #1188's builder, round 5: the shapes its small set holds of its own (40 shapes at 2 and 3, Astra's 15 r3 shapes at 2
// and 4), analysed by `probe/keptseq2.mjs` (/tmp/agent-work/o4-m4-i1188-r5/; copy kept in
// desktop:~/work/evidence/1463/retained/). The set's other programs are earlier runs' (the `1188-*` and `f1-*` modules).
export const cases = [
  [
    "small::matrix|nested-diamonds-3 / small::shape-small|nested-diamonds/3",
    "let t:integer=1\nlet root={f0:t,f1:t,f2:t}\nlet peer={g0:t,g1:t,g2:t}\nlet x0={left:{cell:root},right:{cell:root}}\nlet y0=x0\ny0.left.cell={h0:t}\nlet z0=[y0.left.cell,peer]\nlet w0=[y0.right.cell,peer]\nlet x1={left:{cell:root},right:{cell:root}}\nlet y1=x1\ny1.left.cell={h1:t}\nlet z1=[y1.left.cell,peer]\nlet w1=[y1.right.cell,peer]\nlet x2={left:{cell:root},right:{cell:root}}\nlet y2=x2\ny2.left.cell={h2:t}\nlet z2=[y2.left.cell,peer]\nlet w2=[y2.right.cell,peer]\nexit\n",
  ],
  [
    "small::matrix|rejected-projections-3 / small::shape-small|rejected-projections/3",
    'let t:integer=1\nlet root={f0:t,f1:t,f2:t}\nlet peer={f0:1,f1:1,f2:1}\nlet x0=root\nx0.f0="bad"\nlet box0={cell:x0}\nlet copy0=box0.cell\nlet again0=copy0\nlet pair0=[again0,peer]\nlet x1=root\nx1.f0="bad"\nlet box1={cell:x1}\nlet copy1=box1.cell\nlet again1=copy1\nlet pair1=[again1,peer]\nlet x2=root\nx2.f0="bad"\nlet box2={cell:x2}\nlet copy2=box2.cell\nlet again2=copy2\nlet pair2=[again2,peer]\nexit\n',
  ],
  [
    "small::matrix|guarded-mixed-fan-3 / small::shape-small|guarded-mixed-fan/3",
    "let t:integer=1\nlet root={f0:t,f1:t,f2:t}\nlet peer={f0:1,f1:1,f2:1}\nlet x0=root\nif hostValue { x0={extra0:t} }\nlet y0={slot:x0,direct:{own0:t}}\nlet z0=y0.slot\nlet x1=root\nif hostValue { x1={extra1:t} }\nlet y1={slot:x1,direct:{own1:t}}\nlet z1=y1.slot\nlet x2=root\nif hostValue { x2={extra2:t} }\nlet y2={slot:x2,direct:{own2:t}}\nlet z2=y2.slot\nlet bag=[peer,z0,z1,z2]\nexit\n",
  ],
  [
    "small::matrix|fed-cycle-fan-3 / small::shape-small|fed-cycle-fan/3",
    "let t:integer=1\nlet root={f0:t,f1:t,f2:t}\nlet peer={g0:t,g1:t,g2:t}\nlet a0=root\nlet b0=a0\na0=b0\nb0.extra0=t\nlet c0={nest:b0}\nlet pair0=[c0.nest,peer]\nlet a1=root\nlet b1=a1\na1=b1\nb1.extra1=t\nlet c1={nest:b1}\nlet pair1=[c1.nest,peer]\nlet a2=root\nlet b2=a2\na2=b2\nb2.extra2=t\nlet c2={nest:b2}\nlet pair2=[c2.nest,peer]\nexit\n",
  ],
  [
    "small::matrix|sparse-pairs-3 / small::shape-small|sparse-pairs/3",
    "let t:integer=1\nlet r0={p0k0:t,p0k1:t,p0k2:t}\nlet r1={p1k0:t,p1k1:t,p1k2:t}\nlet r2={p2k0:t,p2k1:t,p2k2:t}\nlet pair0x1=[r0,r1]\nlet pair0x2=[r0,r2]\nlet pair1x2=[r1,r2]\nexit\n",
  ],
  [
    "small::matrix|equal-pairs-3 / small::shape-small|equal-pairs/3",
    "let t:integer=1\nlet r0={f0:t,f1:t,f2:t}\nlet r1={f0:t,f1:t,f2:t}\nlet r2={f0:t,f1:t,f2:t}\nlet pair0x1=[r0,r1]\nlet pair0x2=[r0,r2]\nlet pair1x2=[r1,r2]\nexit\n",
  ],
  [
    "small::matrix|opaque-cyclic-elements-3 / small::shape-small|opaque-cyclic-elements/3",
    "let t:integer=1\nlet u0=hostValue\nu0=u0\nlet u1=hostValue\nu1=u1\nlet u2=hostValue\nu2=u2\nlet bag=[u0,u1,u2,{x:t}]\nexit\n",
  ],
  [
    "small::matrix|fed-cycle-plain-3 / small::shape-small|fed-cycle-plain/3",
    "let t:integer=1\nlet root={f0:t,f1:t,f2:t}\nlet peer={g0:t,g1:t,g2:t}\nlet a0=root\nlet b0=a0\na0=b0\nlet c0={nest:b0}\nlet pair0=[c0.nest,peer]\nlet a1=root\nlet b1=a1\na1=b1\nlet c1={nest:b1}\nlet pair1=[c1.nest,peer]\nlet a2=root\nlet b2=a2\na2=b2\nlet c2={nest:b2}\nlet pair2=[c2.nest,peer]\nexit\n",
  ],
  [
    "small::a-rejection|nested-rejection/2 / small::shape-small|astra3-rejected-nested-projections/2",
    'let unit:integer=7\nlet wide={f0:unit,f1:unit}\nlet sack0=[{box:{f0:"bad"}},{box:wide}]\nlet clone0=sack0\nlet final0=[clone0.first.box,wide]\nlet sack1=[{box:{f0:"bad"}},{box:wide}]\nlet clone1=sack1\nlet final1=[clone1.first.box,wide]\nexit\n',
  ],
  [
    "small::shape-small|prefix-paths/2",
    "let typed:integer=1\nlet root={f0:typed,f1:typed}\nlet c0_0={p0:root,z:root}\nlet c0_1={p0:root,z:root}\nlet c1_0={p1:root,z:root}\nlet c1_1={p1:root,z:root}\nexit\n",
  ],
  [
    "small::shape-small|prefix-paths/3",
    "let typed:integer=1\nlet root={f0:typed,f1:typed,f2:typed}\nlet c0_0={p0:root,z:root}\nlet c0_1={p0:root,z:root}\nlet c1_0={p1:root,z:root}\nlet c1_1={p1:root,z:root}\nlet c2_0={p2:root,z:root}\nlet c2_1={p2:root,z:root}\nexit\n",
  ],
  [
    "small::shape-small|prefix-paths-narrow/2",
    "let typed:integer=1\nlet root={f0:typed}\nlet c0_0={p0:root,z:root}\nlet c0_1={p0:root,z:root}\nlet c1_0={p1:root,z:root}\nlet c1_1={p1:root,z:root}\nexit\n",
  ],
  [
    "small::shape-small|prefix-paths-narrow/3",
    "let typed:integer=1\nlet root={f0:typed}\nlet c0_0={p0:root,z:root}\nlet c0_1={p0:root,z:root}\nlet c1_0={p1:root,z:root}\nlet c1_1={p1:root,z:root}\nlet c2_0={p2:root,z:root}\nlet c2_1={p2:root,z:root}\nexit\n",
  ],
  [
    "small::shape-small|mix-landed/2",
    "let typed:integer=1\nlet r0={f0:typed}\nlet r1={f1:typed}\nlet wide={f0:typed,f1:typed}\nlet a=[r0,r1,wide]\nlet b=[r0,r1]\nexit\n",
  ],
  [
    "small::shape-small|mix-landed/3",
    "let typed:integer=1\nlet r0={f0:typed}\nlet r1={f1:typed}\nlet r2={f2:typed}\nlet wide={f0:typed,f1:typed,f2:typed}\nlet a=[r0,r1,r2,wide]\nlet b=[r0,r1,r2]\nexit\n",
  ],
  [
    "small::shape-small|mix-no-wide/2",
    "let typed:integer=1\nlet r0={f0:typed}\nlet r1={f1:typed}\nlet a=[r0,r1]\nlet b=[r0,r1]\nexit\n",
  ],
  [
    "small::shape-small|mix-no-wide/3",
    "let typed:integer=1\nlet r0={f0:typed}\nlet r1={f1:typed}\nlet r2={f2:typed}\nlet a=[r0,r1,r2]\nlet b=[r0,r1,r2]\nexit\n",
  ],
  [
    "small::shape-small|direct-locals-misfits/2",
    'let typed:integer=1\nlet root={f0:typed,f1:typed}\nlet plain={f0:1,f1:1}\nlet local0=plain\nlocal0.f0="bad"\nlet c0=root\nc0=local0\nlet local1=plain\nlocal1.f1="bad"\nlet c1=root\nc1=local1\nexit\n',
  ],
  [
    "small::shape-small|direct-locals-misfits/3",
    'let typed:integer=1\nlet root={f0:typed,f1:typed,f2:typed}\nlet plain={f0:1,f1:1,f2:1}\nlet local0=plain\nlocal0.f0="bad"\nlet c0=root\nc0=local0\nlet local1=plain\nlocal1.f1="bad"\nlet c1=root\nc1=local1\nlet local2=plain\nlocal2.f2="bad"\nlet c2=root\nc2=local2\nexit\n',
  ],
  [
    "small::shape-small|direct-locals-fitting/2",
    "let typed:integer=1\nlet root={f0:typed,f1:typed}\nlet plain={f0:1,f1:1}\nlet local0=plain\nlocal0.f0=2\nlet c0=root\nc0=local0\nlet local1=plain\nlocal1.f1=2\nlet c1=root\nc1=local1\nexit\n",
  ],
  [
    "small::shape-small|direct-locals-fitting/3",
    "let typed:integer=1\nlet root={f0:typed,f1:typed,f2:typed}\nlet plain={f0:1,f1:1,f2:1}\nlet local0=plain\nlocal0.f0=2\nlet c0=root\nc0=local0\nlet local1=plain\nlocal1.f1=2\nlet c1=root\nc1=local1\nlet local2=plain\nlocal2.f2=2\nlet c2=root\nc2=local2\nexit\n",
  ],
  [
    "small::shape-small|two-wide-disjoint/2",
    'let t:integer=1\nlet s:string="x"\nlet root={f0:t,f1:t}\nlet other={g0:s,g1:s}\nlet a0=[root,other]\nlet a1=[root,other]\nexit\n',
  ],
  [
    "small::shape-small|two-wide-disjoint/3",
    'let t:integer=1\nlet s:string="x"\nlet root={f0:t,f1:t,f2:t}\nlet other={g0:s,g1:s,g2:s}\nlet a0=[root,other]\nlet a1=[root,other]\nlet a2=[root,other]\nexit\n',
  ],
  [
    "small::shape-small|long-locals-narrow/2",
    "let t:integer=1\nlet root={p:t,g0:null,g1:null}\nlet c0=root\nlet c1=c0\nc1.g0=2\nlet c2=c1\nc2.g1=2\nlet o0={p:2}\nlet a0=[c2,o0]\nlet o1={p:2}\nlet a1=[c2,o1]\nexit\n",
  ],
  [
    "small::shape-small|long-locals-narrow/3",
    "let t:integer=1\nlet root={p:t,g0:null,g1:null,g2:null}\nlet c0=root\nlet c1=c0\nc1.g0=2\nlet c2=c1\nc2.g1=2\nlet c3=c2\nc3.g2=2\nlet o0={p:2}\nlet a0=[c3,o0]\nlet o1={p:2}\nlet a1=[c3,o1]\nlet o2={p:2}\nlet a2=[c3,o2]\nexit\n",
  ],
  [
    "small::shape-small|locals-wide/2",
    "let t:integer=1\nlet root={f0:t,f1:t,g0:null,g1:null}\nlet c0=root\nlet c1=c0\nc1.g0=2\nlet c2=c1\nc2.g1=2\nlet o0={f0:2}\nlet a0=[c2,o0]\nlet o1={f1:2}\nlet a1=[c2,o1]\nexit\n",
  ],
  [
    "small::shape-small|locals-wide/3",
    "let t:integer=1\nlet root={f0:t,f1:t,f2:t,g0:null,g1:null,g2:null}\nlet c0=root\nlet c1=c0\nc1.g0=2\nlet c2=c1\nc2.g1=2\nlet c3=c2\nc3.g2=2\nlet o0={f0:2}\nlet a0=[c3,o0]\nlet o1={f1:2}\nlet a1=[c3,o1]\nlet o2={f2:2}\nlet a2=[c3,o2]\nexit\n",
  ],
  [
    "small::shape-small|fat-merge-place/2",
    'let typed:integer=1\nlet s:string="x"\nlet root={f0:typed,f1:typed}\nlet other={g0:s,g1:s}\nlet o0={h0:typed}\nlet d0=root\nd0=o0\nlet a0=d0\na0=other\nlet o1={h1:typed}\nlet d1=root\nd1=o1\nlet a1=d1\na1=other\nexit\n',
  ],
  [
    "small::shape-small|fat-merge-place/3",
    'let typed:integer=1\nlet s:string="x"\nlet root={f0:typed,f1:typed,f2:typed}\nlet other={g0:s,g1:s,g2:s}\nlet o0={h0:typed}\nlet d0=root\nd0=o0\nlet a0=d0\na0=other\nlet o1={h1:typed}\nlet d1=root\nd1=o1\nlet a1=d1\na1=other\nlet o2={h2:typed}\nlet d2=root\nd2=o2\nlet a2=d2\na2=other\nexit\n',
  ],
  [
    "small::shape-small|fat-merge-literal/2",
    'let typed:integer=1\nlet s:string="x"\nlet root={f0:typed,f1:typed}\nlet other={g0:s,g1:s}\nlet o0={h0:typed}\nlet d0=root\nd0=o0\nlet a0=[d0,other]\nlet o1={h1:typed}\nlet d1=root\nd1=o1\nlet a1=[d1,other]\nexit\n',
  ],
  [
    "small::shape-small|fat-merge-literal/3",
    'let typed:integer=1\nlet s:string="x"\nlet root={f0:typed,f1:typed,f2:typed}\nlet other={g0:s,g1:s,g2:s}\nlet o0={h0:typed}\nlet d0=root\nd0=o0\nlet a0=[d0,other]\nlet o1={h1:typed}\nlet d1=root\nd1=o1\nlet a1=[d1,other]\nlet o2={h2:typed}\nlet d2=root\nd2=o2\nlet a2=[d2,other]\nexit\n',
  ],
  [
    "small::shape-small|fat-merge-place-control/2",
    'let typed:integer=1\nlet s:string="x"\nlet root={f0:typed,f1:typed}\nlet other={g0:s,g1:s}\nlet o0={h0:typed}\nlet d0=root\nd0.h0=2\nlet a0=d0\na0=other\nlet o1={h1:typed}\nlet d1=root\nd1.h1=2\nlet a1=d1\na1=other\nexit\n',
  ],
  [
    "small::shape-small|fat-merge-place-control/3",
    'let typed:integer=1\nlet s:string="x"\nlet root={f0:typed,f1:typed,f2:typed}\nlet other={g0:s,g1:s,g2:s}\nlet o0={h0:typed}\nlet d0=root\nd0.h0=2\nlet a0=d0\na0=other\nlet o1={h1:typed}\nlet d1=root\nd1.h1=2\nlet a1=d1\na1=other\nlet o2={h2:typed}\nlet d2=root\nd2.h2=2\nlet a2=d2\na2=other\nexit\n',
  ],
  [
    "small::shape-small|fat-merge-alone/2",
    "let typed:integer=1\nlet root={f0:typed,f1:typed}\nlet o0={h0:typed}\nlet d0=root\nd0=o0\nlet a0=d0\nlet o1={h1:typed}\nlet d1=root\nd1=o1\nlet a1=d1\nexit\n",
  ],
  [
    "small::shape-small|fat-merge-alone/3",
    "let typed:integer=1\nlet root={f0:typed,f1:typed,f2:typed}\nlet o0={h0:typed}\nlet d0=root\nd0=o0\nlet a0=d0\nlet o1={h1:typed}\nlet d1=root\nd1=o1\nlet a1=d1\nlet o2={h2:typed}\nlet d2=root\nd2=o2\nlet a2=d2\nexit\n",
  ],
  [
    "small::shape-small|fat-chain-place/2",
    'let typed:integer=1\nlet s:string="x"\nlet root={f0:typed,f1:typed}\nlet other={g0:s,g1:s}\nlet m0=root\nlet o1={h1:typed}\nlet m1=m0\nm1=o1\nlet a1=m1\na1=other\nlet o2={h2:typed}\nlet m2=m1\nm2=o2\nlet a2=m2\na2=other\nexit\n',
  ],
  [
    "small::shape-small|fat-chain-place/3",
    'let typed:integer=1\nlet s:string="x"\nlet root={f0:typed,f1:typed,f2:typed}\nlet other={g0:s,g1:s,g2:s}\nlet m0=root\nlet o1={h1:typed}\nlet m1=m0\nm1=o1\nlet a1=m1\na1=other\nlet o2={h2:typed}\nlet m2=m1\nm2=o2\nlet a2=m2\na2=other\nlet o3={h3:typed}\nlet m3=m2\nm3=o3\nlet a3=m3\na3=other\nexit\n',
  ],
  [
    "small::shape-small|distinct-wide-pairs/2",
    "let typed:integer=1\nlet r0={a0x0:typed,a0x1:typed}\nlet r1={a1x0:typed,a1x1:typed}\nlet p0_1=[r0,r1]\nexit\n",
  ],
  [
    "small::shape-small|distinct-wide-pairs/3",
    "let typed:integer=1\nlet r0={a0x0:typed,a0x1:typed,a0x2:typed}\nlet r1={a1x0:typed,a1x1:typed,a1x2:typed}\nlet r2={a2x0:typed,a2x1:typed,a2x2:typed}\nlet p0_1=[r0,r1]\nlet p0_2=[r0,r2]\nlet p1_2=[r1,r2]\nexit\n",
  ],
  [
    "small::shape-small|distinct-wide-pairs-shared/2",
    "let typed:integer=1\nlet r0={f0:typed,f1:typed}\nlet r1={f0:typed,f1:typed}\nlet p0_1=[r0,r1]\nexit\n",
  ],
  [
    "small::shape-small|distinct-wide-pairs-shared/3",
    "let typed:integer=1\nlet r0={f0:typed,f1:typed,f2:typed}\nlet r1={f0:typed,f1:typed,f2:typed}\nlet r2={f0:typed,f1:typed,f2:typed}\nlet p0_1=[r0,r1]\nlet p0_2=[r0,r2]\nlet p1_2=[r1,r2]\nexit\n",
  ],
  [
    "small::shape-small|list-of-records/2",
    "let t:integer=1\nlet root={f0:t,f1:t}\nlet o0={f0:2}\nlet o1={f1:2}\nlet a=[root,o0,o1]\nexit\n",
  ],
  [
    "small::shape-small|list-of-records/3",
    "let t:integer=1\nlet root={f0:t,f1:t,f2:t}\nlet o0={f0:2}\nlet o1={f1:2}\nlet o2={f2:2}\nlet a=[root,o0,o1,o2]\nexit\n",
  ],
  [
    "small::shape-small|meet-reads-groups-shared/2",
    "let t:integer=1\nlet plain={f0:{left:1,right:1},f1:{left:1,right:1}}\nlet w0={q:t}\nlet w1={q:t}\nlet p={y0:w0,y1:w1,x0:plain.f0,x1:plain.f1}\nlet p2={y0:w0,y1:w1,x0:plain.f0,x1:plain.f1}\nexit\n",
  ],
  [
    "small::shape-small|meet-reads-groups-shared/3",
    "let t:integer=1\nlet plain={f0:{left:1,right:1},f1:{left:1,right:1},f2:{left:1,right:1}}\nlet w0={q:t}\nlet w1={q:t}\nlet w2={q:t}\nlet p={y0:w0,y1:w1,y2:w2,x0:plain.f0,x1:plain.f1,x2:plain.f2}\nlet p2={y0:w0,y1:w1,y2:w2,x0:plain.f0,x1:plain.f1,x2:plain.f2}\nexit\n",
  ],
  [
    "small::shape-small|valid-copy-prefixes/2",
    "let t:integer=1\nlet w={q:t,r:1}\nlet root={f0:{a:{b:{c:w,d:w},e:w},z:w},f1:{a:{b:{c:w,d:w},e:w},z:w}}\nlet a=root\nlet b=a\nb.f0.a.b.c=w\nb.f0.z=w\nb.f0.a.b.d.r=2\nlet r0=b.f0.a.b\nlet s0=b.f0.a.b.c\nlet u0=b.f0.a.b.c.q\nb.f1.a.b.c=w\nb.f1.z=w\nb.f1.a.b.d.r=2\nlet r1=b.f1.a.b\nlet s1=b.f1.a.b.c\nlet u1=b.f1.a.b.c.q\nexit\n",
  ],
  [
    "small::shape-small|valid-copy-prefixes/3",
    "let t:integer=1\nlet w={q:t,r:1}\nlet root={f0:{a:{b:{c:w,d:w},e:w},z:w},f1:{a:{b:{c:w,d:w},e:w},z:w},f2:{a:{b:{c:w,d:w},e:w},z:w}}\nlet a=root\nlet b=a\nb.f0.a.b.c=w\nb.f0.z=w\nb.f0.a.b.d.r=2\nlet r0=b.f0.a.b\nlet s0=b.f0.a.b.c\nlet u0=b.f0.a.b.c.q\nb.f1.a.b.c=w\nb.f1.z=w\nb.f1.a.b.d.r=2\nlet r1=b.f1.a.b\nlet s1=b.f1.a.b.c\nlet u1=b.f1.a.b.c.q\nb.f2.a.b.c=w\nb.f2.z=w\nb.f2.a.b.d.r=2\nlet r2=b.f2.a.b\nlet s2=b.f2.a.b.c\nlet u2=b.f2.a.b.c.q\nexit\n",
  ],
  [
    "small::shape-small|chain-partner3/2",
    'let typed:integer=1\nlet s:string="x"\nlet root={f0:typed,f1:typed}\nlet other={g0:s,g1:s,g2:s,g3:s,g4:s,g5:s}\nlet m0=root\nlet o1={h1:typed}\nlet m1=m0\nm1=o1\nlet a1=m1\na1=other\nlet o2={h2:typed}\nlet m2=m1\nm2=o2\nlet a2=m2\na2=other\nexit\n',
  ],
  [
    "small::shape-small|chain-partner3/3",
    'let typed:integer=1\nlet s:string="x"\nlet root={f0:typed,f1:typed,f2:typed}\nlet other={g0:s,g1:s,g2:s,g3:s,g4:s,g5:s,g6:s,g7:s,g8:s}\nlet m0=root\nlet o1={h1:typed}\nlet m1=m0\nm1=o1\nlet a1=m1\na1=other\nlet o2={h2:typed}\nlet m2=m1\nm2=o2\nlet a2=m2\na2=other\nlet o3={h3:typed}\nlet m3=m2\nm3=o3\nlet a3=m3\na3=other\nexit\n',
  ],
  [
    "small::shape-small|chain-partner8/2",
    'let typed:integer=1\nlet s:string="x"\nlet root={f0:typed,f1:typed}\nlet other={g0:s,g1:s,g2:s,g3:s,g4:s,g5:s,g6:s,g7:s,g8:s,g9:s,g10:s,g11:s,g12:s,g13:s,g14:s,g15:s}\nlet m0=root\nlet o1={h1:typed}\nlet m1=m0\nm1=o1\nlet a1=m1\na1=other\nlet o2={h2:typed}\nlet m2=m1\nm2=o2\nlet a2=m2\na2=other\nexit\n',
  ],
  [
    "small::shape-small|chain-partner8/3",
    'let typed:integer=1\nlet s:string="x"\nlet root={f0:typed,f1:typed,f2:typed}\nlet other={g0:s,g1:s,g2:s,g3:s,g4:s,g5:s,g6:s,g7:s,g8:s,g9:s,g10:s,g11:s,g12:s,g13:s,g14:s,g15:s,g16:s,g17:s,g18:s,g19:s,g20:s,g21:s,g22:s,g23:s}\nlet m0=root\nlet o1={h1:typed}\nlet m1=m0\nm1=o1\nlet a1=m1\na1=other\nlet o2={h2:typed}\nlet m2=m1\nm2=o2\nlet a2=m2\na2=other\nlet o3={h3:typed}\nlet m3=m2\nm3=o3\nlet a3=m3\na3=other\nexit\n',
  ],
  [
    "small::shape-small|holder-fan-in-plain/2",
    "let t:integer=1\nlet root={f0:t,f1:t}\nlet other={f0:1,f1:1}\nlet o0={h0:t}\nlet d0=root\nd0=o0\nlet o1={h1:t}\nlet d1=root\nd1=o1\nlet a=[other,d0,d1]\nexit\n",
  ],
  [
    "small::shape-small|holder-fan-in-plain/3",
    "let t:integer=1\nlet root={f0:t,f1:t,f2:t}\nlet other={f0:1,f1:1,f2:1}\nlet o0={h0:t}\nlet d0=root\nd0=o0\nlet o1={h1:t}\nlet d1=root\nd1=o1\nlet o2={h2:t}\nlet d2=root\nd2=o2\nlet a=[other,d0,d1,d2]\nexit\n",
  ],
  [
    "small::shape-small|holder-fan-in-fitting/2",
    "let t:integer=1\nlet root={f0:t,f1:t}\nlet other={f0:t,f1:t}\nlet o0={h0:t}\nlet d0=root\nd0=o0\nlet o1={h1:t}\nlet d1=root\nd1=o1\nlet a=[other,d0,d1]\nexit\n",
  ],
  [
    "small::shape-small|holder-fan-in-fitting/3",
    "let t:integer=1\nlet root={f0:t,f1:t,f2:t}\nlet other={f0:t,f1:t,f2:t}\nlet o0={h0:t}\nlet d0=root\nd0=o0\nlet o1={h1:t}\nlet d1=root\nd1=o1\nlet o2={h2:t}\nlet d2=root\nd2=o2\nlet a=[other,d0,d1,d2]\nexit\n",
  ],
  [
    "small::shape-small|holder-fan-in-plain-narrow/2",
    "let t:integer=1\nlet root={f0:t}\nlet other={f0:1}\nlet o0={h0:t}\nlet d0=root\nd0=o0\nlet o1={h1:t}\nlet d1=root\nd1=o1\nlet a=[other,d0,d1]\nexit\n",
  ],
  [
    "small::shape-small|holder-fan-in-plain-narrow/3",
    "let t:integer=1\nlet root={f0:t}\nlet other={f0:1}\nlet o0={h0:t}\nlet d0=root\nd0=o0\nlet o1={h1:t}\nlet d1=root\nd1=o1\nlet o2={h2:t}\nlet d2=root\nd2=o2\nlet a=[other,d0,d1,d2]\nexit\n",
  ],
  [
    "small::shape-small|opaque-cyclic-elements/2",
    "let t:integer=1\nlet u0=hostValue\nu0=u0\nlet u1=hostValue\nu1=u1\nlet bag=[u0,u1,{x:t}]\nexit\n",
  ],
  [
    "small::shape-small|fed-cycle-store/2",
    "let t:integer=1\nlet root={f0:t,f1:t}\nlet peer={g0:t,g1:t}\nlet a0=root\nlet b0=a0\na0=b0\nb0.f0=t\nlet c0={nest:b0}\nlet pair0=[c0.nest,peer]\nlet a1=root\nlet b1=a1\na1=b1\nb1.f0=t\nlet c1={nest:b1}\nlet pair1=[c1.nest,peer]\nexit\n",
  ],
  [
    "small::shape-small|fed-cycle-store/3",
    "let t:integer=1\nlet root={f0:t,f1:t,f2:t}\nlet peer={g0:t,g1:t,g2:t}\nlet a0=root\nlet b0=a0\na0=b0\nb0.f0=t\nlet c0={nest:b0}\nlet pair0=[c0.nest,peer]\nlet a1=root\nlet b1=a1\na1=b1\nb1.f0=t\nlet c1={nest:b1}\nlet pair1=[c1.nest,peer]\nlet a2=root\nlet b2=a2\na2=b2\nb2.f0=t\nlet c2={nest:b2}\nlet pair2=[c2.nest,peer]\nexit\n",
  ],
  [
    "small::shape-small|fed-cycle-plain/2",
    "let t:integer=1\nlet root={f0:t,f1:t}\nlet peer={g0:t,g1:t}\nlet a0=root\nlet b0=a0\na0=b0\nlet c0={nest:b0}\nlet pair0=[c0.nest,peer]\nlet a1=root\nlet b1=a1\na1=b1\nlet c1={nest:b1}\nlet pair1=[c1.nest,peer]\nexit\n",
  ],
  [
    "small::shape-small|acyclic-store/2",
    "let t:integer=1\nlet root={f0:t,f1:t}\nlet peer={g0:t,g1:t}\nlet a0=root\nlet b0=a0\nb0.f0=t\nlet c0={nest:b0}\nlet pair0=[c0.nest,peer]\nlet a1=root\nlet b1=a1\nb1.f0=t\nlet c1={nest:b1}\nlet pair1=[c1.nest,peer]\nexit\n",
  ],
  [
    "small::shape-small|acyclic-store/3",
    "let t:integer=1\nlet root={f0:t,f1:t,f2:t}\nlet peer={g0:t,g1:t,g2:t}\nlet a0=root\nlet b0=a0\nb0.f0=t\nlet c0={nest:b0}\nlet pair0=[c0.nest,peer]\nlet a1=root\nlet b1=a1\nb1.f0=t\nlet c1={nest:b1}\nlet pair1=[c1.nest,peer]\nlet a2=root\nlet b2=a2\nb2.f0=t\nlet c2={nest:b2}\nlet pair2=[c2.nest,peer]\nexit\n",
  ],
  [
    "small::shape-small|fed-cycle-fan/2",
    "let t:integer=1\nlet root={f0:t,f1:t}\nlet peer={g0:t,g1:t}\nlet a0=root\nlet b0=a0\na0=b0\nb0.extra0=t\nlet c0={nest:b0}\nlet pair0=[c0.nest,peer]\nlet a1=root\nlet b1=a1\na1=b1\nb1.extra1=t\nlet c1={nest:b1}\nlet pair1=[c1.nest,peer]\nexit\n",
  ],
  [
    "small::shape-small|nested-diamonds/2",
    "let t:integer=1\nlet root={f0:t,f1:t}\nlet peer={g0:t,g1:t}\nlet x0={left:{cell:root},right:{cell:root}}\nlet y0=x0\ny0.left.cell={h0:t}\nlet z0=[y0.left.cell,peer]\nlet w0=[y0.right.cell,peer]\nlet x1={left:{cell:root},right:{cell:root}}\nlet y1=x1\ny1.left.cell={h1:t}\nlet z1=[y1.left.cell,peer]\nlet w1=[y1.right.cell,peer]\nexit\n",
  ],
  [
    "small::shape-small|guarded-mixed-fan/2",
    "let t:integer=1\nlet root={f0:t,f1:t}\nlet peer={f0:1,f1:1}\nlet x0=root\nif hostValue { x0={extra0:t} }\nlet y0={slot:x0,direct:{own0:t}}\nlet z0=y0.slot\nlet x1=root\nif hostValue { x1={extra1:t} }\nlet y1={slot:x1,direct:{own1:t}}\nlet z1=y1.slot\nlet bag=[peer,z0,z1]\nexit\n",
  ],
  [
    "small::shape-small|rejected-projections/2",
    'let t:integer=1\nlet root={f0:t,f1:t}\nlet peer={f0:1,f1:1}\nlet x0=root\nx0.f0="bad"\nlet box0={cell:x0}\nlet copy0=box0.cell\nlet again0=copy0\nlet pair0=[again0,peer]\nlet x1=root\nx1.f0="bad"\nlet box1={cell:x1}\nlet copy1=box1.cell\nlet again1=copy1\nlet pair1=[again1,peer]\nexit\n',
  ],
  [
    "small::shape-small|sparse-pairs/2",
    "let t:integer=1\nlet r0={p0k0:t,p0k1:t}\nlet r1={p1k0:t,p1k1:t}\nlet pair0x1=[r0,r1]\nexit\n",
  ],
  [
    "small::shape-small|equal-pairs/2",
    "let t:integer=1\nlet r0={f0:t,f1:t}\nlet r1={f0:t,f1:t}\nlet pair0x1=[r0,r1]\nexit\n",
  ],
  [
    "small::shape-small|opaque-fixed-contributors/2",
    "let typed:integer=1\nlet u0=hostValue\nu0=u0\nlet u1=hostValue\nu1=u1\nlet wide={f0:typed,f1:typed}\nlet bag=[u0,u1,wide]\nexit\n",
  ],
  [
    "small::shape-small|opaque-fixed-contributors/3",
    "let typed:integer=1\nlet u0=hostValue\nu0=u0\nlet u1=hostValue\nu1=u1\nlet wide={f0:typed,f1:typed,f2:typed}\nlet bag=[u0,u1,wide]\nexit\n",
  ],
  [
    "small::shape-small|opaque-fan-host/2",
    "let typed:integer=1\nlet root={f0:typed,f1:typed}\nlet u0=hostValue\nlet c0=root\nc0=u0\nlet u1=hostValue\nlet c1=root\nc1=u1\nexit\n",
  ],
  [
    "small::shape-small|opaque-fan-host/3",
    "let typed:integer=1\nlet root={f0:typed,f1:typed,f2:typed}\nlet u0=hostValue\nlet c0=root\nc0=u0\nlet u1=hostValue\nlet c1=root\nc1=u1\nlet u2=hostValue\nlet c2=root\nc2=u2\nexit\n",
  ],
  [
    "small::shape-small|opaque-fan-call/2",
    "let typed:integer=1\nlet root={f0:typed,f1:typed}\nlet u0=make(0)\nlet c0=root\nc0=u0\nlet u1=make(1)\nlet c1=root\nc1=u1\nexit\nfunction make(v) {\n    return {f0:v,f1:v}\n}\nexit\n",
  ],
  [
    "small::shape-small|opaque-fan-call/3",
    "let typed:integer=1\nlet root={f0:typed,f1:typed,f2:typed}\nlet u0=make(0)\nlet c0=root\nc0=u0\nlet u1=make(1)\nlet c1=root\nc1=u1\nlet u2=make(2)\nlet c2=root\nc2=u2\nexit\nfunction make(v) {\n    return {f0:v,f1:v,f2:v}\n}\nexit\n",
  ],
  [
    "small::shape-small|fed-cycle-store-place/2",
    "let typed:integer=1\nlet root={f0:typed,f1:typed}\nlet peer={g0:typed,g1:typed}\nlet a0=root\nlet b0=a0\na0=b0\nb0.f0=typed\nlet c0={nest:b0}\nlet m0=c0.nest\nm0=peer\nlet a1=root\nlet b1=a1\na1=b1\nb1.f0=typed\nlet c1={nest:b1}\nlet m1=c1.nest\nm1=peer\nexit\n",
  ],
  [
    "small::shape-small|fed-cycle-store-place/3",
    "let typed:integer=1\nlet root={f0:typed,f1:typed,f2:typed}\nlet peer={g0:typed,g1:typed,g2:typed}\nlet a0=root\nlet b0=a0\na0=b0\nb0.f0=typed\nlet c0={nest:b0}\nlet m0=c0.nest\nm0=peer\nlet a1=root\nlet b1=a1\na1=b1\nb1.f0=typed\nlet c1={nest:b1}\nlet m1=c1.nest\nm1=peer\nlet a2=root\nlet b2=a2\na2=b2\nb2.f0=typed\nlet c2={nest:b2}\nlet m2=c2.nest\nm2=peer\nexit\n",
  ],
  [
    "small::shape-small|opaque-cycle-place/2",
    "let t:integer=1\nlet u0=hostValue\nu0=u0\nlet u1=hostValue\nu1=u1\nlet bag={x:t}\nbag=u0\nbag=u1\nexit\n",
  ],
  [
    "small::shape-small|opaque-cycle-place/3",
    "let t:integer=1\nlet u0=hostValue\nu0=u0\nlet u1=hostValue\nu1=u1\nlet u2=hostValue\nu2=u2\nlet bag={x:t}\nbag=u0\nbag=u1\nbag=u2\nexit\n",
  ],
  [
    "small::shape-small|opaque-written-cycle-place/2",
    "let u0:object=hostValue\nu0=u0\nlet u1:object=hostValue\nu1=u1\nlet bag=u0\nbag=u1\nexit\n",
  ],
  [
    "small::shape-small|opaque-written-cycle-place/3",
    "let u0:object=hostValue\nu0=u0\nlet u1:object=hostValue\nu1=u1\nlet u2:object=hostValue\nu2=u2\nlet bag=u0\nbag=u1\nbag=u2\nexit\n",
  ],
  [
    "small::shape-small|astra3-rejected-nested-projections/4",
    'let unit:integer=7\nlet wide={f0:unit,f1:unit,f2:unit,f3:unit}\nlet sack0=[{box:{f0:"bad"}},{box:wide}]\nlet clone0=sack0\nlet final0=[clone0.first.box,wide]\nlet sack1=[{box:{f0:"bad"}},{box:wide}]\nlet clone1=sack1\nlet final1=[clone1.first.box,wide]\nlet sack2=[{box:{f0:"bad"}},{box:wide}]\nlet clone2=sack2\nlet final2=[clone2.first.box,wide]\nlet sack3=[{box:{f0:"bad"}},{box:wide}]\nlet clone3=sack3\nlet final3=[clone3.first.box,wide]\nexit\n',
  ],
  [
    "small::shape-small|astra3-opaque-fitting-parameters/2",
    "let unit:integer=7\nlet wide={f0:unit,f1:unit}\nfunction use0(arg) { let copy=wide\ncopy=arg }\nuse0(wide)\nfunction use1(arg) { let copy=wide\ncopy=arg }\nuse1(wide)\nexit\n",
  ],
  [
    "small::shape-small|astra3-opaque-fitting-parameters/4",
    "let unit:integer=7\nlet wide={f0:unit,f1:unit,f2:unit,f3:unit}\nfunction use0(arg) { let copy=wide\ncopy=arg }\nuse0(wide)\nfunction use1(arg) { let copy=wide\ncopy=arg }\nuse1(wide)\nfunction use2(arg) { let copy=wide\ncopy=arg }\nuse2(wide)\nfunction use3(arg) { let copy=wide\ncopy=arg }\nuse3(wide)\nexit\n",
  ],
  [
    "small::shape-small|astra3-opaque-fitting-object-result/2",
    "let unit:integer=7\nlet wide={f0:unit,f1:unit}\nfunction give0(arg):object { return wide }\nlet a0=wide\na0=give0(0)\nfunction give1(arg):object { return wide }\nlet a1=wide\na1=give1(1)\nexit\n",
  ],
  [
    "small::shape-small|astra3-opaque-fitting-object-result/4",
    "let unit:integer=7\nlet wide={f0:unit,f1:unit,f2:unit,f3:unit}\nfunction give0(arg):object { return wide }\nlet a0=wide\na0=give0(0)\nfunction give1(arg):object { return wide }\nlet a1=wide\na1=give1(1)\nfunction give2(arg):object { return wide }\nlet a2=wide\na2=give2(2)\nfunction give3(arg):object { return wide }\nlet a3=wide\na3=give3(3)\nexit\n",
  ],
  [
    "small::shape-small|astra3-opaque-nested-fold/2",
    "let unit:integer=7\nlet h0=hostValue\nh0=h0\nlet w0={box:h0}\nlet h1=hostValue\nh1=h1\nlet w1={box:h1}\nlet bag=[w0.box,w1.box,{inner:{flag:unit}}]\nexit\n",
  ],
  [
    "small::shape-small|astra3-opaque-nested-fold/4",
    "let unit:integer=7\nlet h0=hostValue\nh0=h0\nlet w0={box:h0}\nlet h1=hostValue\nh1=h1\nlet w1={box:h1}\nlet h2=hostValue\nh2=h2\nlet w2={box:h2}\nlet h3=hostValue\nh3=h3\nlet w3={box:h3}\nlet bag=[w0.box,w1.box,w2.box,w3.box,{inner:{flag:unit}}]\nexit\n",
  ],
  [
    "small::shape-small|astra3-opaque-nested-fixed/2",
    "let unit:integer=7\nlet h=hostValue\nh=h\nlet w0={box:h}\nlet w1={box:h}\nlet bag=[w0.box,w1.box,{inner:{flag:unit}}]\nexit\n",
  ],
  [
    "small::shape-small|astra3-opaque-nested-fixed/4",
    "let unit:integer=7\nlet h=hostValue\nh=h\nlet w0={box:h}\nlet w1={box:h}\nlet w2={box:h}\nlet w3={box:h}\nlet bag=[w0.box,w1.box,w2.box,w3.box,{inner:{flag:unit}}]\nexit\n",
  ],
  [
    "small::shape-small|astra3-rejected-transit-fan/2",
    'let unit:integer=7\nlet wide={f0:unit,f1:unit}\nlet text={f0:"bad"}\nlet bad=[text,wide]\nlet parcel={box:bad}\nlet carry=parcel\nlet hop0=carry\nlet bowl0=[hop0.box.first,text]\nlet hop1=carry\nlet bowl1=[hop1.box.first,text]\nexit\n',
  ],
  [
    "small::shape-small|astra3-rejected-transit-fan/4",
    'let unit:integer=7\nlet wide={f0:unit,f1:unit,f2:unit,f3:unit}\nlet text={f0:"bad"}\nlet bad=[text,wide]\nlet parcel={box:bad}\nlet carry=parcel\nlet hop0=carry\nlet bowl0=[hop0.box.first,text]\nlet hop1=carry\nlet bowl1=[hop1.box.first,text]\nlet hop2=carry\nlet bowl2=[hop2.box.first,text]\nlet hop3=carry\nlet bowl3=[hop3.box.first,text]\nexit\n',
  ],
  [
    "small::shape-small|astra3-seeded-ring-place/2",
    "let unit:integer=7\nlet wide={f0:unit,f1:unit}\nlet other={g0:unit,g1:unit}\nlet a0=wide\nlet b0=a0\nlet c0=b0\na0=c0\nc0.f0=unit\nlet parcel0={box:b0}\nlet join0=parcel0.box\njoin0=other\nlet a1=wide\nlet b1=a1\nlet c1=b1\na1=c1\nc1.f1=unit\nlet parcel1={box:b1}\nlet join1=parcel1.box\njoin1=other\nexit\n",
  ],
  [
    "small::shape-small|astra3-seeded-ring-place/4",
    "let unit:integer=7\nlet wide={f0:unit,f1:unit,f2:unit,f3:unit}\nlet other={g0:unit,g1:unit,g2:unit,g3:unit}\nlet a0=wide\nlet b0=a0\nlet c0=b0\na0=c0\nc0.f0=unit\nlet parcel0={box:b0}\nlet join0=parcel0.box\njoin0=other\nlet a1=wide\nlet b1=a1\nlet c1=b1\na1=c1\nc1.f1=unit\nlet parcel1={box:b1}\nlet join1=parcel1.box\njoin1=other\nlet a2=wide\nlet b2=a2\nlet c2=b2\na2=c2\nc2.f2=unit\nlet parcel2={box:b2}\nlet join2=parcel2.box\njoin2=other\nlet a3=wide\nlet b3=a3\nlet c3=b3\na3=c3\nc3.f3=unit\nlet parcel3={box:b3}\nlet join3=parcel3.box\njoin3=other\nexit\n",
  ],
  [
    "small::shape-small|astra3-seeded-ring-literal/2",
    "let unit:integer=7\nlet wide={f0:unit,f1:unit}\nlet other={g0:unit,g1:unit}\nlet a0=wide\nlet b0=a0\nlet c0=b0\na0=c0\nc0.f0=unit\nlet parcel0={box:b0}\nlet join0=[parcel0.box,other]\nlet a1=wide\nlet b1=a1\nlet c1=b1\na1=c1\nc1.f1=unit\nlet parcel1={box:b1}\nlet join1=[parcel1.box,other]\nexit\n",
  ],
  [
    "small::shape-small|astra3-seeded-ring-literal/4",
    "let unit:integer=7\nlet wide={f0:unit,f1:unit,f2:unit,f3:unit}\nlet other={g0:unit,g1:unit,g2:unit,g3:unit}\nlet a0=wide\nlet b0=a0\nlet c0=b0\na0=c0\nc0.f0=unit\nlet parcel0={box:b0}\nlet join0=[parcel0.box,other]\nlet a1=wide\nlet b1=a1\nlet c1=b1\na1=c1\nc1.f1=unit\nlet parcel1={box:b1}\nlet join1=[parcel1.box,other]\nlet a2=wide\nlet b2=a2\nlet c2=b2\na2=c2\nc2.f2=unit\nlet parcel2={box:b2}\nlet join2=[parcel2.box,other]\nlet a3=wide\nlet b3=a3\nlet c3=b3\na3=c3\nc3.f3=unit\nlet parcel3={box:b3}\nlet join3=[parcel3.box,other]\nexit\n",
  ],
  [
    "small::shape-small|astra3-cold-meetings/2",
    "let unit:integer=7\nlet wide={f0:1.25,f1:1.25}\nlet narrow={f0:unit,f1:unit}\nlet mix=wide\nmix=narrow\nlet copy0=mix\ncopy0=narrow\nlet copy1=mix\ncopy1=narrow\nexit\n",
  ],
  [
    "small::shape-small|astra3-cold-meetings/4",
    "let unit:integer=7\nlet wide={f0:1.25,f1:1.25,f2:1.25,f3:1.25}\nlet narrow={f0:unit,f1:unit,f2:unit,f3:unit}\nlet mix=wide\nmix=narrow\nlet copy0=mix\ncopy0=narrow\nlet copy1=mix\ncopy1=narrow\nlet copy2=mix\ncopy2=narrow\nlet copy3=mix\ncopy3=narrow\nexit\n",
  ],
  [
    "small::shape-small|astra3-cold-meetings-fixed-width/2",
    "let unit:integer=7\nlet wide={f0:1.25}\nlet narrow={f0:unit}\nlet mix=wide\nmix=narrow\nlet copy0=mix\ncopy0=narrow\nlet copy1=mix\ncopy1=narrow\nexit\n",
  ],
  [
    "small::shape-small|astra3-cold-meetings-fixed-width/4",
    "let unit:integer=7\nlet wide={f0:1.25}\nlet narrow={f0:unit}\nlet mix=wide\nmix=narrow\nlet copy0=mix\ncopy0=narrow\nlet copy1=mix\ncopy1=narrow\nlet copy2=mix\ncopy2=narrow\nlet copy3=mix\ncopy3=narrow\nexit\n",
  ],
  [
    "small::shape-small|astra3-cold-meetings-literals/2",
    "let unit:integer=7\nlet wide={f0:1.25,f1:1.25}\nlet narrow={f0:unit,f1:unit}\nlet mix=wide\nmix=narrow\nlet copy0=[mix,narrow]\nlet copy1=[mix,narrow]\nexit\n",
  ],
  [
    "small::shape-small|astra3-cold-meetings-literals/4",
    "let unit:integer=7\nlet wide={f0:1.25,f1:1.25,f2:1.25,f3:1.25}\nlet narrow={f0:unit,f1:unit,f2:unit,f3:unit}\nlet mix=wide\nmix=narrow\nlet copy0=[mix,narrow]\nlet copy1=[mix,narrow]\nlet copy2=[mix,narrow]\nlet copy3=[mix,narrow]\nexit\n",
  ],
  [
    "small::shape-small|astra3-opaque-fitting-functions/2",
    "let unit:integer=7\nlet wide={f0:unit,f1:unit}\nfunction source0(unused) { return wide }\nlet opaque0=source0(0)\nlet copy0=wide\ncopy0=opaque0\nfunction source1(unused) { return wide }\nlet opaque1=source1(1)\nlet copy1=wide\ncopy1=opaque1\nexit\n",
  ],
  [
    "small::shape-small|astra3-opaque-fitting-functions/4",
    "let unit:integer=7\nlet wide={f0:unit,f1:unit,f2:unit,f3:unit}\nfunction source0(unused) { return wide }\nlet opaque0=source0(0)\nlet copy0=wide\ncopy0=opaque0\nfunction source1(unused) { return wide }\nlet opaque1=source1(1)\nlet copy1=wide\ncopy1=opaque1\nfunction source2(unused) { return wide }\nlet opaque2=source2(2)\nlet copy2=wide\ncopy2=opaque2\nfunction source3(unused) { return wide }\nlet opaque3=source3(3)\nlet copy3=wide\ncopy3=opaque3\nexit\n",
  ],
  [
    "small::shape-small|astra3-opaque-fitting-read-cycle/2",
    "let unit:integer=7\nlet wide={f0:unit,f1:unit}\nlet wrap0={box:wide}\nlet opaque0=wrap0.box\nwrap0.box=opaque0\nlet copy0=wide\ncopy0=opaque0\nlet wrap1={box:wide}\nlet opaque1=wrap1.box\nwrap1.box=opaque1\nlet copy1=wide\ncopy1=opaque1\nexit\n",
  ],
  [
    "small::shape-small|astra3-opaque-fitting-read-cycle/4",
    "let unit:integer=7\nlet wide={f0:unit,f1:unit,f2:unit,f3:unit}\nlet wrap0={box:wide}\nlet opaque0=wrap0.box\nwrap0.box=opaque0\nlet copy0=wide\ncopy0=opaque0\nlet wrap1={box:wide}\nlet opaque1=wrap1.box\nwrap1.box=opaque1\nlet copy1=wide\ncopy1=opaque1\nlet wrap2={box:wide}\nlet opaque2=wrap2.box\nwrap2.box=opaque2\nlet copy2=wide\ncopy2=opaque2\nlet wrap3={box:wide}\nlet opaque3=wrap3.box\nwrap3.box=opaque3\nlet copy3=wide\ncopy3=opaque3\nexit\n",
  ],
  [
    "small::shape-small|astra3-residual-private/2",
    "let unit:integer=7\nlet root0={p0f0:unit,p0f1:unit}\nlet root1={p1f0:unit,p1f1:unit}\nlet pair0x1={nest:[root0,root1]}\nexit\n",
  ],
  [
    "small::shape-small|astra3-residual-private/4",
    "let unit:integer=7\nlet root0={p0f0:unit,p0f1:unit,p0f2:unit,p0f3:unit}\nlet root1={p1f0:unit,p1f1:unit,p1f2:unit,p1f3:unit}\nlet root2={p2f0:unit,p2f1:unit,p2f2:unit,p2f3:unit}\nlet root3={p3f0:unit,p3f1:unit,p3f2:unit,p3f3:unit}\nlet pair0x1={nest:[root0,root1]}\nlet pair0x2={nest:[root0,root2]}\nlet pair0x3={nest:[root0,root3]}\nlet pair1x2={nest:[root1,root2]}\nlet pair1x3={nest:[root1,root3]}\nlet pair2x3={nest:[root2,root3]}\nexit\n",
  ],
  [
    "small::shape-small|astra3-residual-same/2",
    "let unit:integer=7\nlet root0={f0:unit,f1:unit}\nlet root1={f0:unit,f1:unit}\nlet pair0x1={nest:[root0,root1]}\nexit\n",
  ],
  [
    "small::shape-small|astra3-residual-same/4",
    "let unit:integer=7\nlet root0={f0:unit,f1:unit,f2:unit,f3:unit}\nlet root1={f0:unit,f1:unit,f2:unit,f3:unit}\nlet root2={f0:unit,f1:unit,f2:unit,f3:unit}\nlet root3={f0:unit,f1:unit,f2:unit,f3:unit}\nlet pair0x1={nest:[root0,root1]}\nlet pair0x2={nest:[root0,root2]}\nlet pair0x3={nest:[root0,root3]}\nlet pair1x2={nest:[root1,root2]}\nlet pair1x3={nest:[root1,root3]}\nlet pair2x3={nest:[root2,root3]}\nexit\n",
  ],
];

// the globals the recorded run passed
export const globals = ["hostValue", "hostInit"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "env $e node probe/keptseq2.mjs $PWD/trees/$tree cases/small.json out/$tag-$tree-small.jsonl",
      "/tmp/agent-work/o4-m4-i1188-r5/probe/q2.sh:10",
    ],
  ],
  sources: 110,
  sha256: "de3cac6c50193ab3804a898d5ae27d1b33e0c3c7621d1ef6a874b7fdf09cb79f",
};
