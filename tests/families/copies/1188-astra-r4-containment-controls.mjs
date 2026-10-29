// astra-m4-i1188-design-recheck-r4-evidence; archived Python/shell evidence.
export const cases = (() => {
  let domain, extra, first, intro, order, out, pair, shape, start, tail, union, wrapper, written;
  out = [];
  function add(name, ...lines) {
    out.push({ name: name, source: lines.join("\n") + "\nexit\n" });
  }
  for (domain of ["integer", "integer | string"]) {
    for (shape of ["direct", "projection", "dict", "property"]) {
      intro = [
        `let sample:${domain}=29`,
        "let parcel={weight:sample}",
        "let damaged=[{weight:false},parcel]",
      ];
      if (shape === "direct") {
        tail = ["let outcome=parcel", "outcome=damaged.first"];
      } else {
        if (shape === "projection") {
          intro = [
            `let sample:${domain}=29`,
            "let parcel={meta:{weight:sample}}",
            "let damaged=[{meta:{weight:false}},parcel]",
          ];
          tail = ["let outcome=parcel.meta", "outcome=damaged.first.meta"];
        } else {
          if (shape === "dict") {
            intro = [
              `let sample:${domain}=29`,
              "let parcel={weight:sample}",
              "let damaged=dict{a:{weight:false},b:parcel}",
            ];
            tail = ["let outcome=parcel", "outcome=damaged.values.first"];
          } else {
            tail = ["let outcome={slot:parcel}", "outcome.slot=damaged.first"];
          }
        }
      }
      add(`reversed/${domain}/${shape}`, ...intro, ...tail);
    }
  }
  for (written of ["integer", "integer | string"]) {
    for (order of [false, true]) {
      for (wrapper of [false, true]) {
        intro = [
          `let ix:${written}=7`,
          "let wide={v:ix}",
          "let peer={v:ix}",
          "let damaged=[{v:false},wide]",
        ];
        first = "damaged.first";
        if (wrapper) {
          intro.push(...["let box={value:damaged.first}", "let relay=box"]);
          first = "relay.value";
        }
        pair = order ? `${first},peer` : `peer,${first}`;
        add(`form2/${written}/${order}/${wrapper}`, ...intro, `let result=[${pair}]`);
      }
    }
  }
  for (union of ["integer | string", "integer | string | boolean", "number"]) {
    for (start of ["83", "false", '"live"']) {
      for (extra of ["83", "false", '"live"']) {
        add(
          `bare/${union}/${start}/${extra}`,
          `let written:${union}=83`,
          "let annotated={v:written,tag:1}",
          `let inside={v:${start},tag:false}`,
          "inside=annotated",
          "let outer=inside",
          `outer={v:${extra},tag:false}`,
          "let result=[inside,outer]",
        );
      }
    }
  }

  return out.map((c) => [c.name, c.source]);
})();
export const checks = ["publication"];
