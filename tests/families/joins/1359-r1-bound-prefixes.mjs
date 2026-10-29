// #1359 review r1 (reviewer not recorded); retained in #1417.
export const sizes = [3, 6];
export const shapes = (() => {
  const many = (n, f, by = ", ") => Array.from({ length: n }, (_, i) => f(i)).join(by);
  const lines = (...s) => s.join("\n");
  const shapes = {
    boundWideHost: (k) =>
      lines(
        `let root = {${many(k, (i) => `f${i}: hostValue`)}}`,
        `let xs = [${many(k, () => "root")}]`,
        "let n: integer = xs[hostValue.i].f0",
        "exit",
      ),
    boundWideHostProjection: (k) =>
      lines(
        `let root = {${many(k, (i) => `f${i}: hostValue.n`)}}`,
        `let xs = [${many(k, () => "root")}]`,
        "let n: integer = xs[hostValue.i].f0",
        "exit",
      ),
    boundWideConstant: (k) =>
      lines(
        `let root = {${many(k, (i) => `f${i}: ${i}`)}}`,
        `let xs = [${many(k, () => "root")}]`,
        "let n: integer = xs[hostValue.i].f0",
        "exit",
      ),
    boundJoinCopies: (k) =>
      lines(
        "let first: (integer | string)[] = [0]",
        `let joined = first + ${many(k, (i) => `[${i}]`, " + ")} + ["x"]`,
        `let xs = [${many(k, () => "joined")}]`,
        "say xs[hostValue.i][0]",
        "exit",
      ),
    boundJoinHostCopies: (k) =>
      lines(
        `let joined = hostValue + ${many(k, (i) => `[${i}]`, " + ")}`,
        `let xs = [${many(k, () => "joined")}]`,
        "say xs[0][0]",
        "exit",
      ),
    boundOtherwiseCopies: (k) =>
      lines(
        `let root = ${many(k, (i) => `hostValue.f${i}`, " otherwise ")} otherwise {a: 0}`,
        `let xs = [${many(k, () => "root")}]`,
        "let n: integer = xs[0].a",
        "exit",
      ),
    boundScalarOperation: (k) =>
      lines(
        `let root = hostValue + ${many(k, (i) => `${i}`, " + ")}`,
        `let xs = [${many(k, () => "root")}]`,
        "say xs[0]",
        "exit",
      ),
    boundGetChain: (k) =>
      lines(
        `let root = hostValue${many(k, (i) => `.get("a", default: {n: ${i}})`, "")}`,
        `let xs = [${many(k, () => "root")}]`,
        "let n: integer = xs[hostValue.i].n",
        "exit",
      ),
    boundMaxChain: (k) =>
      lines(
        `let root = ${"max(".repeat(k)}hostValue${many(k, (i) => `, ${i})`, "")}`,
        `let xs = [${many(k, () => "root")}]`,
        "say xs[0]",
        "exit",
      ),
    wrappedJoinPrefixes: (k) =>
      lines(
        "let first: (integer | string)[] = [0]",
        `let result = ${Array.from({ length: k }, (_, i) => i).reduce((s, i) => `({n: ${s} + [${i}]}).n`, "first")} + ["s"]`,
        "say result.length",
        "exit",
      ),
    wrappedScalarPrefixes: (k) =>
      lines(
        `let result = ${Array.from({ length: k }, (_, i) => i).reduce((s, i) => `({n: ${s} + ${i}}).n`, "hostValue")}`,
        "say result",
        "exit",
      ),
    wrappedFallbackPrefixes: (k) =>
      lines(
        `let result = ${Array.from({ length: k }, (_, i) => i).reduce((s, i) => `({n: (${s} otherwise hostValue.f${i})}).n`, "hostValue")}`,
        "let n: integer = result",
        "exit",
      ),
    boundHostSeparateLists: (k) =>
      lines(
        `let root = {${many(k, (i) => `f${i}: hostValue`)}}`,
        many(
          k,
          (i) => `let xs${i} = [root, {f0: 1}]\nlet n${i}: integer = xs${i}[hostValue.i].f0`,
          "\n",
        ),
        "exit",
      ),
    boundJoinSeparateLists: (k) =>
      lines(
        "let first: (integer | string)[] = [0]",
        `let root = first + ${many(k, (i) => `[${i}]`, " + ")} + ["s"]`,
        many(k, (i) => `let xs${i} = [root, [1]]\nsay xs${i}[hostValue.i][0]`, "\n"),
        "exit",
      ),
  };
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
