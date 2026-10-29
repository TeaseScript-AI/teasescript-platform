// #1359 review r3 (reviewer not recorded); retained in #1417.
export const sizes = [4, 8];
export const shapes = (() => {
  const many = (k, f, sep = ", ") => Array.from({ length: k }, (_, i) => f(i)).join(sep);
  const chain = (k, seed = "hostValue") =>
    `${"max(".repeat(k)}${seed}${many(k, (i) => `, ${i})`, "")}`;
  const wide = (k) => `max(${many(k, (i) => `hostValue.f${i}`)})`;
  const pair = (expr) => `let left = ${expr}\nlet right = ${expr}\n`;
  const sites = (k, values = "left, right", read = "xs[i][hostValue.i]") =>
    many(
      k,
      (i) =>
        `let xs${i} = [${typeof values === "function" ? values(i) : values}]\nlet n${i}: integer = ${read.replaceAll("[i]", String(i))}`,
      "\n",
    ) + "\nexit";
  const shapes = {
    wideMaxLeaves: (k) => pair(wide(k)) + sites(k),
    reversedMaxPeers: (k) =>
      pair(chain(k)) + sites(k, (i) => (i % 2 ? "right, left" : "left, right")),
    interleavedMaxPeers: (k) => pair(chain(k)) + sites(k, 'false, left, "x", right'),
    aliasedMaxPeers: (k) => pair(chain(k)) + "let a = left\nlet b = right\n" + sites(k, "a, b"),
    projectedMaxPeers: (k) => pair(`{v: ${chain(k)}}`) + sites(k, "left.v, right.v"),
    wrappedMaxPeers: (k) => pair(chain(k)) + sites(k, "({v: left}).v, ({v: right}).v"),
    literalLeaves: (k) =>
      pair(`{v: [${many(k, (i) => `hostValue.f${i}`)}]}`) +
      sites(k, "left, right", "xs[i][hostValue.i].v[hostValue.j]"),
    listLeaves: (k) =>
      pair(`[${many(k, (i) => `hostValue.f${i}`)}]`) +
      sites(k, "left, right", "xs[i][hostValue.i][hostValue.j]"),
    loadDefaults: (k) => pair(`load("x", default: ${wide(k)})`) + sites(k),
    repeatChoices: (k) =>
      pair(chain(k)) +
      many(
        k,
        (i) =>
          `let n${i} = askChoice {text: "a", value: left}, {text: "b", value: right}\nsay n${i}`,
        "\n",
      ) +
      "\nexit",
    boundChoice: (k) =>
      `let left = askChoice ${many(k, (i) => `{text: "${i}", value: hostValue.f${i}}`)}\nlet right = askChoice ${many(k, (i) => `{text: "${i}", value: hostValue.f${i}}`)}\n` +
      sites(k),
    flatMaxPure: (k) => pair(`max(${many(k, (i) => i + 1)})`) + sites(k, "left, right", "xs[i][0]"),
  };
  const result = {};
  const leaf = (v) =>
    typeof v === "string" ||
    (Array.isArray(v) &&
      v.every((f) => f && typeof f.path === "string" && typeof f.source === "string"));
  for (const [name, make] of Object.entries(shapes)) {
    const sample = make(4);
    if (leaf(sample)) result[name] = make;
    else
      for (const [variant, source] of Object.entries(sample))
        if (leaf(source)) result[name + "/" + variant] = (n) => make(n)[variant];
  }
  return result;
})();
export const checks = ["publication"];
