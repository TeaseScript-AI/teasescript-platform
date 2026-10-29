// #1359 review r1 (reviewer not recorded); retained in #1417.
export const cases = (() => {
  const files = (source) => [{ path: "main.tease", source }];
  const cases = [];
  for (const named of [false, true])
    for (const rotation of [0, 1, 5, 11]) {
      const expressions = Array.from(
        { length: 12 },
        (_, i) =>
          [
            `hostValue.box${i}`,
            `load("k${i}", default: hostValue.box${i})`,
            `(otherHost.box${i} otherwise {z: ${i % 2 ? "1" : '"s"'}, a: ${i % 2 ? '"s"' : "1"}, nested: {p: ${i % 2 ? "true" : "1"}, q: ${i % 2 ? "1" : '"s"'}}})`,
          ][i % 3],
      );
      expressions.push(
        '{z: 1, a: "s", nested: {p: 1, q: "s"}}',
        '{z: "s", a: 1, nested: {p: true, q: 1}}',
      );
      const names = expressions.map((_, i) => `v${i}`);
      const rows = named ? names : expressions;
      const rotated = [...rows.slice(rotation), ...rows.slice(0, rotation)];
      const source = [
        named ? expressions.map((x, i) => `let v${i} = ${x}`).join("\n") : "",
        `let xs = [${rotated.join(", ")}]`,
        `let ys = [${[...rotated].reverse().join(", ")}]`,
        "say xs[hostValue.index].nested.p",
        "say ys[hostValue.index].a",
        "exit",
      ].join("\n");
      cases.push({
        name: `conflict-${named ? "named" : "direct"}-rotation-${rotation}`,
        files: files(source),
      });
    }
  for (const [name, source] of Object.entries({
    aliases:
      "let raw = hostValue\nlet a = {n: raw}\nlet b = {n: raw}\nlet xs = [a, b, {n: 1}]\nlet n: integer = xs[hostValue.i].n\nexit",
    callResult:
      'function one {\nreturn {a: 1, b: "s"}\n}\nlet xs = [one(), one(), {a: "s", b: 1}]\nsay xs[hostValue.i].a\nexit',
    callStores:
      'function one(x) {\nif x {\nreturn {n: 1}\n}\nreturn {n: "s"}\n}\nlet xs = [one(true), one(false), {n: false}]\nsay xs[hostValue.i].n\nexit',
    choiceValues:
      'let picked = askChoice [{text: "a", value: {n: hostValue}}, {text: "b", value: {n: otherHost}}]\nlet xs = [picked, {n: 1}]\nlet n: integer = xs[hostValue.i].n\nexit',
    choiceLabels:
      'let first = askChoice "a", "b", "c"\nlet second = askChoice "b", "a", "c"\nlet xs = [first, second]\nsay xs[hostValue.i]\nexit',
    getFallback:
      'let a = hostValue.get("n", default: {a: 1, b: "s"})\nlet b = otherHost.get("n", default: {a: "s", b: 1})\nlet xs = [a, b]\nsay xs[hostValue.i].a\nexit',
    computedLoad:
      'let a = load(hostValue.key, default: {n: 1})\nlet b = load(otherHost.key, default: {n: "s"})\nlet xs = [a, b]\nsay xs[hostValue.i].n\nexit',
    fallbackNull:
      'let xs = [(null otherwise {n: 1}), (hostValue otherwise {n: "s"}), (otherHost otherwise {n: false})]\nsay xs[hostValue.i].n\nexit',
    markedLiteral:
      "let a = hostValue\nif a.n is integer {\nlet xs = [{n: a.n}, {n: hostValue.n}, {n: otherHost.n}]\nlet n: integer = xs[hostValue.i].n\n}\nexit",
    loopCycle:
      'let root = {n: hostValue}\nlet flag = askBoolean "go"\nwhile flag {\nroot = {n: root.n}\nflag = false\n}\nlet xs = [root, {n: otherHost}]\nlet n: integer = xs[hostValue.i].n\nexit',
    boundJoin:
      'let a = [hostValue] + [1] + ["s"]\nlet b = [otherHost] + [2] + ["t"]\nlet xs = [a, b]\nsay xs[hostValue.i][hostValue.j]\nexit',
    boundMixedRoles:
      "let one = hostValue\nlet two = otherHost\nlet a = {n: one, list: [two]}\nlet b = {n: two, list: [one]}\nlet xs = [a, b]\nsay xs[hostValue.i].list[0]\nexit",
  }))
    cases.push({ name, files: files(source) });
  return cases.map((c, i) => [c.name ?? c.id ?? String(i), c.files]);
})();
export const checks = ["publication"];
