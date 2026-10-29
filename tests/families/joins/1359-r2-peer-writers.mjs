// #1359 review r2 (reviewer not recorded); retained in #1417.
export const sizes = [3, 6];
export const shapes = (() => {
  const many = (k, f, sep = ", ") => Array.from({ length: k }, (_, i) => f(i)).join(sep);
  const join = (k) => `seed + ${many(k, (i) => `[${i}]`, " + ")} + ["s"]`;
  const pair = (k) =>
    `let seed: (integer | string)[] = [0]\nlet left = ${join(k)}\nlet right = ${join(k)}\n`;
  const shapes = {
    peerJoinSeparateLists: (k) =>
      pair(k) +
      many(
        k,
        (i) => `let xs${i} = [left, right]\nlet n${i}: integer = xs${i}[hostValue.i][0]`,
        "\n",
      ) +
      "\nexit",
    peerJoinOneList: (k) =>
      pair(k) +
      `let xs = [${many(k, (i) => (i % 2 ? "right" : "left"))}]\nlet n: integer = xs[hostValue.i][0]\nexit`,
    peerJoinChoiceOptions: (k) =>
      pair(k) +
      `let xs = askChoice ${many(k, (i) => `{text: "${i}", value: ${i % 2 ? "right" : "left"}}`)}\nsay xs[0]\nexit`,
    oneBoundChoiceOptions: (k) =>
      `let seed: (integer | string)[] = [0]\nlet root = ${join(k)}\nlet xs = askChoice ${many(k, (i) => `{text: "${i}", value: root}`)}\nsay xs[0]\nexit`,
    oneBoundPeerLists: (k) =>
      `let seed: (integer | string)[] = [0]\nlet root = ${join(k)}\n` +
      many(
        k,
        (i) => `let xs${i} = [root, root]\nlet n${i}: integer = xs${i}[hostValue.i][0]`,
        "\n",
      ) +
      "\nexit",
    peerScalarSeparateLists: (k) =>
      `let left = hostValue.n + ${many(k, (i) => i, " + ")}\nlet right = hostValue.n + ${many(k, (i) => i, " + ")}\n` +
      many(k, (i) => `let xs${i} = [left, right]\nsay xs${i}[hostValue.i]`, "\n") +
      "\nexit",
  };
  const hostJoin = (k) => `hostValue.items + ${many(k, (i) => `[${i}]`, " + ")} + ["s"]`;
  const hostPair = (k) => `let left = ${hostJoin(k)}\nlet right = ${hostJoin(k)}\n`;
  shapes.peerHostJoinSeparateLists = (k) =>
    hostPair(k) +
    many(
      k,
      (i) => `let xs${i} = [left, right]\nlet n${i}: integer = xs${i}[hostValue.i][0]`,
      "\n",
    ) +
    "\nexit";
  shapes.peerHostJoinOneList = (k) =>
    hostPair(k) +
    `let xs = [${many(k, (i) => (i % 2 ? "left" : "right"))}]\nlet n: integer = xs[hostValue.i][0]\nexit`;
  shapes.peerHostScalarLists = (k) =>
    `let left = hostValue.n + ${many(k, (i) => i, " + ")}\nlet right = hostValue.n + ${many(k, (i) => i, " + ")}\n` +
    many(k, (i) => `let xs${i} = [left, right]\nlet n${i}: integer = xs${i}[hostValue.i]`, "\n") +
    "\nexit";
  const freshJoin = (k) => `[hostValue] + ${many(k, (i) => `[${i}]`, " + ")} + ["s"]`;
  const freshPair = (k) => `let left = ${freshJoin(k)}\nlet right = ${freshJoin(k)}\n`;
  shapes.peerFreshJoinLists = (k) =>
    freshPair(k) +
    many(
      k,
      (i) => `let xs${i} = [left, right]\nlet n${i}: integer = xs${i}[hostValue.i][0]`,
      "\n",
    ) +
    "\nexit";
  shapes.peerFreshJoinOneList = (k) =>
    freshPair(k) +
    `let xs = [${many(k, (i) => (i % 2 ? "left" : "right"))}]\nlet n: integer = xs[hostValue.i][0]\nexit`;
  const max = (k) => `${"max(".repeat(k)}hostValue${many(k, (i) => `, ${i})`, "")}`;
  shapes.peerMaxLists = (k) =>
    `let left = ${max(k)}\nlet right = ${max(k)}\n` +
    many(k, (i) => `let xs${i} = [left, right]\nlet n${i}: integer = xs${i}[hostValue.i]`, "\n") +
    "\nexit";
  shapes.boundJoinTwicePerList = (k) =>
    `let root = hostValue + ${many(k, (i) => `[${i}]`, " + ")}\n` +
    many(k, (i) => `let xs${i} = [root, root]\nlet n${i}: integer = xs${i}[hostValue.i][0]`, "\n") +
    "\nexit";
  const constantMax = (k) => `${"max(".repeat(k)}0${many(k, (i) => `, ${i + 1})`, "")}`;
  shapes.constantMaxPeerLists = (k) =>
    `let left = ${constantMax(k)}\nlet right = ${constantMax(k)}\n` +
    many(k, (i) => `let xs${i} = [left, right]\nsay xs${i}[0]`, "\n") +
    "\nexit";
  shapes.constantMaxPeerOneList = (k) =>
    `let left = ${constantMax(k)}\nlet right = ${constantMax(k)}\nlet xs = [${many(k, (i) => (i % 2 ? "left" : "right"))}]\nsay xs[0]\nexit`;
  const result = {};
  const leaf = (v) =>
    typeof v === "string" ||
    (Array.isArray(v) &&
      v.every((f) => f && typeof f.path === "string" && typeof f.source === "string"));
  for (const [name, make] of Object.entries(shapes)) {
    const sample = make(3);
    if (leaf(sample)) result[name] = make;
    else
      for (const [variant, source] of Object.entries(sample))
        if (leaf(source)) result[name + "/" + variant] = (n) => make(n)[variant];
  }
  return result;
})();
export const checks = ["publication"];
