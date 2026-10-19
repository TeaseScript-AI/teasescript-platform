/**
 * The profiler sweep's varied synthetic script (the orchestrator, 2026-10-19; `evidence/profiler-sweep-r33.md`): one
 * source mixing every construct the solver handles, at a scale `n` of units, each unit a few statements of each
 * kind: scalars stored twice, a list appended in feedback at two sites and read, nested, converted to a set and
 * held in a dict; an object literal with a stored third property, its reads and a copy, and an object of its own
 * names; a written union rebuilt, a `get` default, an `otherwise`, a conversion with a default, a text length,
 * `min`; every tenth unit a choice and a form over the objects; every twentieth a mutual feedback of two lists.
 * The work-bounds test walks it as a growth series; the sweep measured it to 2,000 units.
 */
const lines = (k: number, line: (i: number) => string): string =>
  Array.from({ length: k }, (_, i) => line(i)).join("\n");

export function variedSource(n: number): string {
  const parts = [
    lines(n, (i) => `let v${i} = ${i % 3 === 0 ? `"t${i}"` : i % 3 === 1 ? `${i}` : "true"}`),
    lines(n, (i) => `v${i} = ${i % 3 === 0 ? `"u${i}"` : i % 3 === 1 ? `${i + 1}` : "false"}`),
    lines(
      n,
      (i) =>
        `let l${i} = [${i}]\nl${i} = l${i} + [${i + 1}]\nl${i}.add(${i + 2})\nlet lf${i} = l${i}.first\nlet nl${i} = [l${i}]\nlet s${i} = l${i}.toSet()\nlet d${i} = dict {"k${i}": l${i}}`,
    ),
    lines(
      n,
      (i) =>
        `let o${i} = {a: ${i}, b: "s${i}"}\no${i}.c = l${i}\nlet oa${i} = o${i}.a\nlet oc${i} = o${i}.c\nlet oo${i} = o${i}\nlet p${i} = {q${i}: 0}\np${i}.r${i} = 1\nlet pr${i} = p${i}.r${i}`,
    ),
    lines(
      n,
      (i) =>
        `let w${i}: integer[] | string[] = [${i}]\nw${i} = w${i} + []\nlet g${i} = [[${i}]].get(0, default: [${i + 1}])\nlet ot${i} = l${i} otherwise [${i}]\nlet j${i} = fromJson("1", default: ${i})\nlet t${i} = toString(v${i}).length\nlet m${i} = min(${i}, ${i + 1})`,
    ),
    lines(
      Math.ceil(n / 10),
      (i) =>
        `let ch${i} = askChoice o${(i * 10) % n}.a, o${(i * 10 + 1) % n}.a\nlet f${i} = askForm("Q${i}", fields: {q: {options: [${i}, ${i + 1}]}})\nlet fq${i} = f${i}.q`,
    ),
    lines(
      Math.ceil(n / 20),
      (i) =>
        `let x${i} = [${i}]\nlet y${i} = [${i + 1}]\nx${i} = x${i} + y${i}\ny${i} = y${i} + x${i}`,
    ),
  ];
  return `${parts.join("\n")}\nexit`;
}
