// original r4/r5 generation with 84 retained analysis-selected inputs; #1188, Astra r4/r5
// (R/astra-m4-i1188-design-recheck-r4-evidence/generate.py; R/astra-m4-i1188-recheck-r5-evidence/prepare-cases.py).
export const cases = (() => {
  const result = [];
  {
    let a,
      allcases,
      annot,
      b,
      carrier,
      consumer,
      count,
      cross,
      delta,
      domain,
      edgeorder,
      extra,
      feeds,
      form,
      groups,
      initial,
      innerrev,
      lines,
      make,
      memberseed,
      other,
      outer,
      peer,
      read,
      rejecting,
      rejection,
      rev,
      right,
      route,
      seed,
      sink,
      val,
      view;
    groups = {};
    function add(group, name, lines) {
      (groups[group] ??= []).push({
        name: group + "/" + name,
        source: lines.join("\n") + "\nexit\n",
      });
    }
    function consume(read, other, kind, rev) {
      let a, b;
      [a, b] = rev ? [other, read] : [read, other];
      if (kind === "list") {
        return [`let outcome=[${a},${b}]`];
      }
      if (kind === "assign") {
        return [`let outcome=${a}`, `outcome=${b}`];
      }
      return [`let outcome={cargo:${a}}`, `outcome.cargo=${b}`];
    }
    for (annot of ["", ":integer", ":integer | string"]) {
      for (carrier of ["list", "dict", "record"]) {
        for (innerrev of [false, true]) {
          lines = [`let sample${annot}=29`, "let parcel={meta:{weight:sample},ok:true}"];
          [a, b] = ["{meta:{weight:false},ok:true}", "parcel"];
          if (innerrev) {
            [a, b] = [b, a];
          }
          if (carrier === "list") {
            make = `let damaged=[${a},${b}]`;
            read = "damaged.first";
          } else {
            if (carrier === "dict") {
              make = `let damaged=dict{north:${a},south:${b}}`;
              read = "damaged.values.first";
            } else {
              make = `let damaged={contents:[${a},${b}],spare:0}`;
              read = "damaged.contents.first";
            }
          }
          lines.push(
            ...[
              make,
              `let relay0={cargo:${read}}`,
              "let relay1=relay0",
              "let relay2=relay1",
              "let picked=relay2.cargo",
            ],
          );
          for (sink of ["list", "assign", "field"]) {
            for (rev of [false, true]) {
              add(
                "reject",
                `${annot || "inferred"}/${carrier}/${innerrev}/${sink}/${rev}`,
                lines.concat(consume("picked.meta", "parcel.meta", sink, rev)),
              );
            }
          }
        }
      }
    }
    for (seed of ["string", "number", "union"]) {
      right = {
        string: 'let rval:string="r"',
        number: "let rval:number=1.75",
        union: "let rval:integer | string=7",
      }[seed];
      for (edgeorder of [false, true]) {
        for (feeds of ["none", "left", "right", "both"]) {
          lines = [
            "let lval:integer=37",
            right,
            "let a={cell:{v:lval},keep:0}",
            "let b=a",
            "a=b",
            "let c={cell:{v:rval},keep:0}",
            "let d=c",
            "c=d",
          ];
          cross = ["a=d", "c=b"];
          lines.push(...(edgeorder ? cross.slice().reverse() : cross));
          if (["left", "both"].includes(feeds)) {
            lines.push(...["let inlet={cell:{v:lval},keep:0}", "b=inlet"]);
          }
          if (["right", "both"].includes(feeds)) {
            lines.push(...["let supply={cell:{v:rval},keep:0}", "d=supply"]);
          }
          for ([view, consumer] of [
            ["direct", ["let outcome=[b,d]"]],
            [
              "record",
              [
                "let capsule={left:{x:b},right:{x:d}}",
                "let outcome=[capsule.left.x,capsule.right.x]",
              ],
            ],
            [
              "deadcell",
              [
                "let dropped=[{cell:{v:false},keep:0},b]",
                "let view={x:dropped.first}",
                "let outcome=[view.x,d]",
              ],
            ],
          ]) {
            add("cycle", `${seed}/${edgeorder}/${feeds}/${view}`, lines.concat(consumer));
          }
        }
      }
    }
    for (count of [3, 4, 5]) {
      for (rejecting of [false, true]) {
        for (memberseed of [false, true]) {
          lines = ["let input:integer=43", "let first={v:input,spare:0}", "let inlet=first"];
          if (rejecting) {
            lines.push(...["inlet={v:2.75,spare:0}"]);
          }
          lines.push(
            ...["let ring0=inlet"]
              .concat(
                Array.from({ length: count - 1 }, (_, i) => i + 1).map(
                  (i) => `let ring${i}=ring${i - 1}`,
                ),
              )
              .concat([`ring0=ring${count - 1}`]),
          );
          if (memberseed) {
            lines.push(...["ring1.spare=3"]);
          }
          lines.push(
            ...[
              `let dead=[{v:false,spare:0},ring${count - 1}]`,
              "let wrap={r:dead.first}",
              "let peer={v:3.25,spare:0}",
              "let outcome=[peer,wrap.r]",
            ],
          );
          add("cycle", `fed/${count}/${rejecting}/${memberseed}`, lines);
        }
      }
    }
    for (domain of [
      "integer | string",
      "number",
      "integer | number",
      "integer?",
      "integer | string | boolean",
    ]) {
      for (delta of ["47", '"delta"', "2.5", "false", "null"]) {
        for (form of ["direct", "nested", "bare"]) {
          lines = [
            `let declared:${domain}=47`,
            "let base={meta:{v:declared},stable:true}",
            `let extra={meta:{v:${delta}},stable:true}`,
            "let combined=base",
            "combined=extra",
          ];
          if (form === "direct") {
            read = "combined.meta";
            other = "base.meta";
          } else {
            if (form === "nested") {
              lines.push(...["let box={inside:combined}", "let alias=box"]);
              read = "alias.inside.meta";
              other = "base.meta";
            } else {
              lines.push(...["let bad=[{meta:{v:false},stable:true},base]", "combined=bad.first"]);
              read = "combined.meta";
              other = "base.meta";
            }
          }
          add(
            "contain",
            `${domain}/${delta}/${form}`,
            lines.concat([`let outcome=[${read},${other}]`]),
          );
        }
      }
    }
    for (domain of ["integer | string", "number", "integer | string | boolean"]) {
      for (rev of [false, true]) {
        for (extra of ["integer", "string", "boolean"]) {
          val = { integer: "53", string: '"s"', boolean: "false" }[extra];
          lines = [
            `let wide:${domain}=53`,
            `let narrow:${extra}=${val}`,
            "let base={v:narrow}",
            "let combined=base",
            "combined={v:wide}",
          ];
          add(
            "contain",
            `narrow/${domain}/${extra}/${rev}`,
            lines.concat(consume("base", "combined", "list", rev)),
          );
        }
      }
    }
    for (outer of ["list", "dict", "record"]) {
      for (rev of [false, true]) {
        for (rejection of [false, true]) {
          for (peer of ["named", "alias", "fresh"]) {
            lines = ["let atom:integer | string=59", "let payload={detail:{v:atom},spare:0}"];
            if (outer === "list") {
              lines.push(...["let matrix=[[{detail:{v:false},spare:0}],[payload]]"]);
              read = "matrix.first.first.detail";
            } else {
              if (outer === "dict") {
                lines.push(
                  ...["let matrix=[dict{first:{detail:{v:false},spare:0}},dict{last:payload}]"],
                );
                read = "matrix.first.values.first.detail";
              } else {
                lines.push(
                  ...["let matrix=[{tray:[{detail:{v:false},spare:0}]},{tray:[payload]}]"],
                );
                read = "matrix.first.tray.first.detail";
              }
            }
            if (rejection) {
              lines.push(...['let unrelated=["unrelated",false]']);
            }
            if (peer === "alias") {
              lines.push(...["let equivalent=payload", "let second=equivalent"]);
              other = "second.detail";
            } else {
              other = peer === "named" ? "payload.detail" : "{v:atom}";
            }
            add(
              "live",
              `${outer}/${rev}/${rejection}/${peer}`,
              lines.concat(consume(read, other, "list", rev)),
            );
          }
        }
      }
    }
    for (domain of ["integer", "number", "integer?", "number | string", "boolean | string"]) {
      initial = domain === "boolean | string" ? "true" : "61";
      for (route of ["collection", "copies", "function"]) {
        lines = [`let atom:${domain}=${initial}`, "let item={v:atom}"];
        if (route === "collection") {
          lines.push(...["let mixed=[{nest:[{v:false}]},{nest:[item]}]"]);
          read = "mixed.first.nest.first";
        } else {
          if (route === "copies") {
            lines.push(...["let mixed={v:false}", "mixed=item", "let relay=mixed"]);
            read = "relay";
          } else {
            lines.push(
              ...[
                "function forward(x) { return x }",
                "let mixed=[{nest:[{v:false}]},{nest:[item]}]",
                "let relay=forward(mixed.first.nest.first)",
              ],
            );
            read = "relay";
          }
        }
        add("edge", `${domain}/${route}`, lines.concat(consume(read, "item", "list", false)));
      }
    }
    allcases = Object.values(groups).flat();

    result.push(
      ...Object.values(groups)
        .flat()
        .map((c) => [c.name, c.source]),
    );
  }
  {
    let decl, label, live, name, own, pre, start, store, val;
    own = [];
    function add(name, src) {
      src = src
        .replaceAll("hostValue()", "hostValue")
        .split("\n")
        .filter((line) => !line.startsWith("say "))
        .map((line) => line)
        .join("\n");
      own.push({ name: "own/" + name, source: src + "\nexit\n" });
    }
    for ([label, decl] of [
      ["written", "let seed:integer=41"],
      ["inferred", "let seed=41"],
    ]) {
      pre =
        decl +
        '\nlet template={meta:{value:seed}}\nlet rejected=[{meta:{value:"closed"}},template]\n';
      add(
        label + "-nested",
        pre +
          "let target={payload:template}\ntarget.payload=rejected.first\nsay target.payload.meta.value",
      );
      add(
        label + "-copy-chain",
        pre +
          "let envelope={payload:template}\nlet duplicate=envelope\nlet target=duplicate\ntarget.payload=rejected.first\nsay target.payload.meta.value",
      );
      add(
        label + "-projected-scalar",
        pre + "let target=template.meta.value\ntarget=rejected.first.meta.value",
      );
      add(
        label + "-surviving-destination",
        pre +
          "let target={payload:rejected.first}\ntarget.payload=template\nsay target.payload.meta.value",
      );
    }
    pre =
      'let seed:integer=41\nlet template={value:seed}\nlet rejected=[{value:"closed"},template]\n';
    for ([name, start] of [
      ["union-excludes", "let init:integer | boolean=5"],
      ["union-fits", "let init:integer | string=5"],
      ["optional-excludes", "let init:integer?=5"],
      ["optional-fits-string", 'let init:string?="open"'],
      ["unknown-destination", "let init=hostValue()"],
    ]) {
      add(name, pre + start + "\nlet target={value:init}\ntarget=rejected.first\nsay target.value");
    }
    add(
      "copy-replaced-before-bad-store",
      pre +
        "let target=template\nlet chosen={value:true}\ntarget=chosen\ntarget=rejected.first\nsay target.value",
    );
    for ([name, live] of [
      ["unknown-live", "hostValue()"],
      ["partly-fitting-live", "branch"],
      ["null-live", "null"],
    ]) {
      decl = name === "partly-fitting-live" ? "let branch:boolean | integer=false\n" : "";
      add(
        name,
        decl +
          "let seed:integer=41\nlet template={value:seed}\nlet rejected=[{value:" +
          live +
          "},template]\nlet target=template\ntarget=rejected.first\nsay target.value",
      );
    }
    for ([name, decl, val] of [
      ["inferred-widens", "let seed=3", "2.5"],
      ["written-rejects-number", "let seed:integer=3", "2.5"],
      ["written-number-accepts-integer", "let seed:number=3.5", "7"],
    ]) {
      add(
        name,
        decl +
          "\nlet template={meta:{value:seed}}\nlet rejected=[{meta:{value:" +
          val +
          "}},template]\nlet target=template\ntarget=rejected.first\nsay target.meta.value",
      );
    }
    for ([name, decl, store] of [
      ["fitting-nullable", "let target:integer?=7", "null"],
      ["fitting-union", "let target:integer | boolean=7", "false"],
      ["fitting-numeric-written", "let target:number=7", "5"],
      ["fitting-numeric-widened", "let target=7", "2.5"],
      ["fitting-unknown", "let target:integer=7", "hostValue()"],
    ]) {
      add(name, 'let damaged=[true,"bad"]\n' + decl + "\ntarget=" + store);
    }
    add(
      "inferred-receiver-before-store",
      "let seed=41\nlet template={value:seed}\nlet rejected=[{value:false},template]\nlet target=template\ntarget=rejected.first\nsay target.value",
    );
    add(
      "copy-of-list-receiver",
      pre +
        "let target=[template]\nlet copied=target\ncopied[0]=rejected.first\nsay copied[0].value",
    );
    add(
      "deep-list-receiver",
      pre + "let target={rows:[template]}\ntarget.rows[0]=rejected.first\nsay target.rows[0].value",
    );

    result.push(...own.map((c) => [c.name, c.source]));
  }
  // The historical r5 selector used archived compiler records; these remaining fixed inputs are retained. (Its first
  // quick check's own inputs, which the review corrected before its recorded runs, are left out: REPRODUCE.md.)
  return result.concat([
    [
      "reversed/integer/direct",
      "let sample:integer=29\nlet parcel={weight:sample}\nlet damaged=[{weight:false},parcel]\nlet outcome=parcel\noutcome=damaged.first\nexit\n",
    ],
    [
      "reversed/integer/projection",
      "let sample:integer=29\nlet parcel={meta:{weight:sample}}\nlet damaged=[{meta:{weight:false}},parcel]\nlet outcome=parcel.meta\noutcome=damaged.first.meta\nexit\n",
    ],
    [
      "reversed/integer/property",
      "let sample:integer=29\nlet parcel={weight:sample}\nlet damaged=[{weight:false},parcel]\nlet outcome={slot:parcel}\noutcome.slot=damaged.first\nexit\n",
    ],
    [
      "reversed/integer | string/direct",
      "let sample:integer | string=29\nlet parcel={weight:sample}\nlet damaged=[{weight:false},parcel]\nlet outcome=parcel\noutcome=damaged.first\nexit\n",
    ],
    [
      "reversed/integer | string/projection",
      "let sample:integer | string=29\nlet parcel={meta:{weight:sample}}\nlet damaged=[{meta:{weight:false}},parcel]\nlet outcome=parcel.meta\noutcome=damaged.first.meta\nexit\n",
    ],
    [
      "reversed/integer | string/property",
      "let sample:integer | string=29\nlet parcel={weight:sample}\nlet damaged=[{weight:false},parcel]\nlet outcome={slot:parcel}\noutcome.slot=damaged.first\nexit\n",
    ],
    [
      "form2/integer/False/False",
      "let ix:integer=7\nlet wide={v:ix}\nlet peer={v:ix}\nlet damaged=[{v:false},wide]\nlet result=[peer,damaged.first]\nexit\n",
    ],
    [
      "form2/integer/False/True",
      "let ix:integer=7\nlet wide={v:ix}\nlet peer={v:ix}\nlet damaged=[{v:false},wide]\nlet box={value:damaged.first}\nlet relay=box\nlet result=[peer,relay.value]\nexit\n",
    ],
    [
      "form2/integer/True/False",
      "let ix:integer=7\nlet wide={v:ix}\nlet peer={v:ix}\nlet damaged=[{v:false},wide]\nlet result=[damaged.first,peer]\nexit\n",
    ],
    [
      "form2/integer/True/True",
      "let ix:integer=7\nlet wide={v:ix}\nlet peer={v:ix}\nlet damaged=[{v:false},wide]\nlet box={value:damaged.first}\nlet relay=box\nlet result=[relay.value,peer]\nexit\n",
    ],
    [
      "form2/integer | string/False/False",
      "let ix:integer | string=7\nlet wide={v:ix}\nlet peer={v:ix}\nlet damaged=[{v:false},wide]\nlet result=[peer,damaged.first]\nexit\n",
    ],
    [
      "form2/integer | string/False/True",
      "let ix:integer | string=7\nlet wide={v:ix}\nlet peer={v:ix}\nlet damaged=[{v:false},wide]\nlet box={value:damaged.first}\nlet relay=box\nlet result=[peer,relay.value]\nexit\n",
    ],
    [
      "form2/integer | string/True/False",
      "let ix:integer | string=7\nlet wide={v:ix}\nlet peer={v:ix}\nlet damaged=[{v:false},wide]\nlet result=[damaged.first,peer]\nexit\n",
    ],
    [
      "form2/integer | string/True/True",
      "let ix:integer | string=7\nlet wide={v:ix}\nlet peer={v:ix}\nlet damaged=[{v:false},wide]\nlet box={value:damaged.first}\nlet relay=box\nlet result=[relay.value,peer]\nexit\n",
    ],
    [
      "stagecase/integer/direct",
      'let amount:integer=89\nlet shipment={v:amount,k:"ready"}\nlet rejected=[{v:false,k:"ready"},shipment]\nlet result=[rejected.first,shipment]\nexit\n',
    ],
    [
      "stagecase/integer/wrapper",
      'let amount:integer=89\nlet shipment={v:amount,k:"ready"}\nlet rejected=[{v:false,k:"ready"},shipment]\nlet relay={route:rejected}\nlet twin=relay\nlet result=[twin.route.first,shipment]\nexit\n',
    ],
    [
      "stagecase/integer | string/direct",
      'let amount:integer | string=89\nlet shipment={v:amount,k:"ready"}\nlet rejected=[{v:false,k:"ready"},shipment]\nlet result=[rejected.first,shipment]\nexit\n',
    ],
    [
      "stagecase/integer | string/wrapper",
      'let amount:integer | string=89\nlet shipment={v:amount,k:"ready"}\nlet rejected=[{v:false,k:"ready"},shipment]\nlet relay={route:rejected}\nlet twin=relay\nlet result=[twin.route.first,shipment]\nexit\n',
    ],
    [
      "p/same-record",
      'let unit:integer=7\nlet wide={f:unit}\nlet inner=[{f:"bad"},wide]\nlet result=[inner.first,wide]\nexit\n',
    ],
    [
      "p/other-written-record",
      'let unit:integer=7\nlet wide={f:unit}\nlet wide2={f:unit}\nlet inner=[{f:"bad"},wide]\nlet result=[inner.first,wide2]\nexit\n',
    ],
    [
      "p/other-inferred-record",
      'let unit:integer=7\nlet wide={f:unit}\nlet wide3={f:5}\nlet inner=[{f:"bad"},wide]\nlet result=[inner.first,wide3]\nexit\n',
    ],
    [
      "p/other-literal",
      'let unit:integer=7\nlet wide={f:unit}\nlet inner=[{f:"bad"},wide]\nlet result=[inner.first,{f:5}]\nexit\n',
    ],
    [
      "p/other-written-reversed",
      'let unit:integer=7\nlet wide={f:unit}\nlet wide2={f:unit}\nlet inner=[{f:"bad"},wide]\nlet result=[wide2,inner.first]\nexit\n',
    ],
    [
      "p/no-rejection-written",
      'let unit:integer=7\nlet wide={f:unit}\nlet wide2={f:unit}\nlet inner=[{f:"bad"},{f:"bad"}]\nlet result=[inner.first,wide2]\nexit\n',
    ],
    [
      "u/same-record",
      "let unit:integer | string=7\nlet wide={f:unit}\nlet inner=[{f:true},wide]\nlet result=[inner.first,wide]\nexit\n",
    ],
    [
      "u/other-written-record",
      "let unit:integer | string=7\nlet wide={f:unit}\nlet wide2={f:unit}\nlet inner=[{f:true},wide]\nlet result=[inner.first,wide2]\nexit\n",
    ],
    [
      "u/other-inferred-record",
      "let unit:integer | string=7\nlet wide={f:unit}\nlet wide3={f:5}\nlet inner=[{f:true},wide]\nlet result=[inner.first,wide3]\nexit\n",
    ],
    [
      "u/other-literal",
      "let unit:integer | string=7\nlet wide={f:unit}\nlet inner=[{f:true},wide]\nlet result=[inner.first,{f:5}]\nexit\n",
    ],
    [
      "u/other-written-reversed",
      "let unit:integer | string=7\nlet wide={f:unit}\nlet wide2={f:unit}\nlet inner=[{f:true},wide]\nlet result=[wide2,inner.first]\nexit\n",
    ],
    [
      "u/no-rejection-written",
      "let unit:integer | string=7\nlet wide={f:unit}\nlet wide2={f:unit}\nlet inner=[{f:true},{f:true}]\nlet result=[inner.first,wide2]\nexit\n",
    ],
    [
      "nested/integer/first/join",
      "let token:integer=3\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet recv=bad.first.first\nlet out=[recv,seed]\nexit\n",
    ],
    [
      "nested/integer/first/reverse",
      "let token:integer=3\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet recv=bad.first.first\nlet out=[seed,recv]\nexit\n",
    ],
    [
      "nested/integer/first/place",
      "let token:integer=3\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet recv=bad.first.first\nlet out=recv\nout=seed\nexit\n",
    ],
    [
      "nested/integer/copy/join",
      "let token:integer=3\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet tmp=bad\nlet recv=tmp.first.first\nlet out=[recv,seed]\nexit\n",
    ],
    [
      "nested/integer/copy/reverse",
      "let token:integer=3\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet tmp=bad\nlet recv=tmp.first.first\nlet out=[seed,recv]\nexit\n",
    ],
    [
      "nested/integer/copy/place",
      "let token:integer=3\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet tmp=bad\nlet recv=tmp.first.first\nlet out=recv\nout=seed\nexit\n",
    ],
    [
      "nested/integer/field/join",
      "let token:integer=3\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet holder={bag:bad}\nlet recv=holder.bag.first.first\nlet out=[recv,seed]\nexit\n",
    ],
    [
      "nested/integer/field/reverse",
      "let token:integer=3\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet holder={bag:bad}\nlet recv=holder.bag.first.first\nlet out=[seed,recv]\nexit\n",
    ],
    [
      "nested/integer/field/place",
      "let token:integer=3\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet holder={bag:bad}\nlet recv=holder.bag.first.first\nlet out=recv\nout=seed\nexit\n",
    ],
    [
      "nested/integer | string/first/join",
      "let token:integer | string=3\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet recv=bad.first.first\nlet out=[recv,seed]\nexit\n",
    ],
    [
      "nested/integer | string/first/reverse",
      "let token:integer | string=3\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet recv=bad.first.first\nlet out=[seed,recv]\nexit\n",
    ],
    [
      "nested/integer | string/first/place",
      "let token:integer | string=3\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet recv=bad.first.first\nlet out=recv\nout=seed\nexit\n",
    ],
    [
      "nested/integer | string/copy/join",
      "let token:integer | string=3\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet tmp=bad\nlet recv=tmp.first.first\nlet out=[recv,seed]\nexit\n",
    ],
    [
      "nested/integer | string/copy/reverse",
      "let token:integer | string=3\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet tmp=bad\nlet recv=tmp.first.first\nlet out=[seed,recv]\nexit\n",
    ],
    [
      "nested/integer | string/copy/place",
      "let token:integer | string=3\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet tmp=bad\nlet recv=tmp.first.first\nlet out=recv\nout=seed\nexit\n",
    ],
    [
      "nested/integer | string/field/join",
      "let token:integer | string=3\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet holder={bag:bad}\nlet recv=holder.bag.first.first\nlet out=[recv,seed]\nexit\n",
    ],
    [
      "nested/integer | string/field/reverse",
      "let token:integer | string=3\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet holder={bag:bad}\nlet recv=holder.bag.first.first\nlet out=[seed,recv]\nexit\n",
    ],
    [
      "nested/integer | string/field/place",
      "let token:integer | string=3\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet holder={bag:bad}\nlet recv=holder.bag.first.first\nlet out=recv\nout=seed\nexit\n",
    ],
    [
      "nested/string/first/join",
      'let token:string="ok"\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet recv=bad.first.first\nlet out=[recv,seed]\nexit\n',
    ],
    [
      "nested/string/first/reverse",
      'let token:string="ok"\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet recv=bad.first.first\nlet out=[seed,recv]\nexit\n',
    ],
    [
      "nested/string/first/place",
      'let token:string="ok"\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet recv=bad.first.first\nlet out=recv\nout=seed\nexit\n',
    ],
    [
      "nested/string/copy/join",
      'let token:string="ok"\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet tmp=bad\nlet recv=tmp.first.first\nlet out=[recv,seed]\nexit\n',
    ],
    [
      "nested/string/copy/reverse",
      'let token:string="ok"\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet tmp=bad\nlet recv=tmp.first.first\nlet out=[seed,recv]\nexit\n',
    ],
    [
      "nested/string/copy/place",
      'let token:string="ok"\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet tmp=bad\nlet recv=tmp.first.first\nlet out=recv\nout=seed\nexit\n',
    ],
    [
      "nested/string/field/join",
      'let token:string="ok"\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet holder={bag:bad}\nlet recv=holder.bag.first.first\nlet out=[recv,seed]\nexit\n',
    ],
    [
      "nested/string/field/reverse",
      'let token:string="ok"\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet holder={bag:bad}\nlet recv=holder.bag.first.first\nlet out=[seed,recv]\nexit\n',
    ],
    [
      "nested/string/field/place",
      'let token:string="ok"\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet holder={bag:bad}\nlet recv=holder.bag.first.first\nlet out=recv\nout=seed\nexit\n',
    ],
    [
      "nested/inferred/first/join",
      "let token=3\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet recv=bad.first.first\nlet out=[recv,seed]\nexit\n",
    ],
    [
      "nested/inferred/first/reverse",
      "let token=3\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet recv=bad.first.first\nlet out=[seed,recv]\nexit\n",
    ],
    [
      "nested/inferred/first/place",
      "let token=3\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet recv=bad.first.first\nlet out=recv\nout=seed\nexit\n",
    ],
    [
      "nested/inferred/copy/join",
      "let token=3\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet tmp=bad\nlet recv=tmp.first.first\nlet out=[recv,seed]\nexit\n",
    ],
    [
      "nested/inferred/copy/reverse",
      "let token=3\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet tmp=bad\nlet recv=tmp.first.first\nlet out=[seed,recv]\nexit\n",
    ],
    [
      "nested/inferred/copy/place",
      "let token=3\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet tmp=bad\nlet recv=tmp.first.first\nlet out=recv\nout=seed\nexit\n",
    ],
    [
      "nested/inferred/field/join",
      "let token=3\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet holder={bag:bad}\nlet recv=holder.bag.first.first\nlet out=[recv,seed]\nexit\n",
    ],
    [
      "nested/inferred/field/reverse",
      "let token=3\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet holder={bag:bad}\nlet recv=holder.bag.first.first\nlet out=[seed,recv]\nexit\n",
    ],
    [
      "nested/inferred/field/place",
      "let token=3\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet holder={bag:bad}\nlet recv=holder.bag.first.first\nlet out=recv\nout=seed\nexit\n",
    ],
    [
      "nested-with-rejection/integer/store",
      'let stable=4\nstable="rejected"\nlet token:integer=3\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet out=[bad.first.first,seed]\nexit\n',
    ],
    [
      "nested-with-rejection/integer/cell",
      'let rejects=[4,"rejected"]\nlet token:integer=3\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet out=[bad.first.first,seed]\nexit\n',
    ],
    [
      "nested-with-rejection/integer | string/store",
      'let stable=4\nstable="rejected"\nlet token:integer | string=3\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet out=[bad.first.first,seed]\nexit\n',
    ],
    [
      "nested-with-rejection/integer | string/cell",
      'let rejects=[4,"rejected"]\nlet token:integer | string=3\nlet seed={f:token}\nlet bad=[[{f:true}],[seed]]\nlet out=[bad.first.first,seed]\nexit\n',
    ],
    [
      "identity-chain/0/place",
      'let token:integer=3\nlet seed={f:token}\nlet bad=[{f:"bad"},seed]\nlet recv=bad.first\nlet out=recv\nout=seed\nexit\n',
    ],
    [
      "identity-chain/0/literal",
      'let token:integer=3\nlet seed={f:token}\nlet bad=[{f:"bad"},seed]\nlet recv=bad.first\nlet out=[recv,seed]\nexit\n',
    ],
    [
      "identity-chain/1/place",
      'let token:integer=3\nlet seed={f:token}\nlet bad=[{f:"bad"},seed]\nlet recv=bad.first\nlet hop0=recv\nlet out=hop0\nout=seed\nexit\n',
    ],
    [
      "identity-chain/1/literal",
      'let token:integer=3\nlet seed={f:token}\nlet bad=[{f:"bad"},seed]\nlet recv=bad.first\nlet hop0=recv\nlet out=[hop0,seed]\nexit\n',
    ],
    [
      "identity-chain/2/place",
      'let token:integer=3\nlet seed={f:token}\nlet bad=[{f:"bad"},seed]\nlet recv=bad.first\nlet hop0=recv\nlet hop1=hop0\nlet out=hop1\nout=seed\nexit\n',
    ],
    [
      "identity-chain/2/literal",
      'let token:integer=3\nlet seed={f:token}\nlet bad=[{f:"bad"},seed]\nlet recv=bad.first\nlet hop0=recv\nlet hop1=hop0\nlet out=[hop1,seed]\nexit\n',
    ],
    [
      "identity-chain/3/place",
      'let token:integer=3\nlet seed={f:token}\nlet bad=[{f:"bad"},seed]\nlet recv=bad.first\nlet hop0=recv\nlet hop1=hop0\nlet hop2=hop1\nlet out=hop2\nout=seed\nexit\n',
    ],
    [
      "identity-chain/3/literal",
      'let token:integer=3\nlet seed={f:token}\nlet bad=[{f:"bad"},seed]\nlet recv=bad.first\nlet hop0=recv\nlet hop1=hop0\nlet hop2=hop1\nlet out=[hop2,seed]\nexit\n',
    ],
  ]);
})();
export const checks = ["publication"];

// the globals the recorded run passed
export const globals = ["hostValue", "hostInit"];

/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */
export const recorded = {
  commands: [
    [
      "Sources are generated by `python3 generate.py` and `python3 focus.py`. `cases/stagecase.json` is four additional",
      "R/astra-m4-i1188-design-recheck-r4-evidence/REPRODUCE.md:14",
    ],
    [
      "python3 probe-queue.py reject full",
      "R/astra-m4-i1188-design-recheck-r4-evidence/REPRODUCE.md:23",
    ],
    [
      "python3 probe-queue.py cycle full",
      "R/astra-m4-i1188-design-recheck-r4-evidence/REPRODUCE.md:24",
    ],
    [
      "python3 probe-queue.py contain full",
      "R/astra-m4-i1188-design-recheck-r4-evidence/REPRODUCE.md:25",
    ],
    [
      "python3 probe-queue.py live full",
      "R/astra-m4-i1188-design-recheck-r4-evidence/REPRODUCE.md:26",
    ],
    [
      "python3 probe-queue.py edge full",
      "R/astra-m4-i1188-design-recheck-r4-evidence/REPRODUCE.md:27",
    ],
    ["python3 queue.py quick2", "R/astra-m4-i1188-recheck-r5-evidence/REPRODUCE.md:13"],
    ["python3 queue.py own", "R/astra-m4-i1188-recheck-r5-evidence/REPRODUCE.md:14"],
    ["python3 queue.py sample", "R/astra-m4-i1188-recheck-r5-evidence/REPRODUCE.md:15"],
  ],
  sources: 442,
  sha256: "1725cc63c94dd35b13d538209857e3a72c7b50c7e2c90c7a03c3a2cdbce94474",
};
