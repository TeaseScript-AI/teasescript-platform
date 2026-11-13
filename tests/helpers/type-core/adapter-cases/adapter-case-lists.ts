// The templates of the list functions' case tables: the functions over values and selectors, `linearRegression` and
// `predict`.

import {
  type Template,
  LITERAL_KINDS,
  WRITTEN_KINDS,
  literal,
  variant,
  parameterVariant,
} from "./adapter-case-forms.js";

// ---------------------------------------------------------------------------------------------------------------------
// List functions over values and selectors, linearRegression and predict

const STATISTICS: readonly string[] = ["sum", "average", "median", "stddev", "min", "max"];

function statistic(name: string, list: string, more = ""): string {
  return name === "percentile" ? `percentile(${list}, 50${more})` : `${name}(${list}${more})`;
}

export const VALUES_TEMPLATES: readonly Template[] = [
  {
    id: "elements",
    *variants() {
      for (const name of [...STATISTICS, "percentile"]) {
        for (const kind of LITERAL_KINDS)
          yield variant(
            `${name}.${kind}`,
            [],
            statistic(name, `[${literal(kind)}, ${literal(kind, true)}]`),
          );
        yield variant(`${name}.one`, [], statistic(name, "[1]"));
        // An empty list is reported from its known value (`checkFewest`); the result is unknown from the element
        // nothing was stored into.
        yield variant(`${name}.empty`, [], statistic(name, "[]"));
        yield variant(`${name}.mixed-numbers`, [], statistic(name, "[1, 2.5]"));
        yield variant(`${name}.host-list`, [], statistic(name, "hostList"), "host");
        yield variant(`${name}.host-element`, [], statistic(name, "[hostValue]"), "host");
      }
      for (const kind of WRITTEN_KINDS) {
        yield variant(`sum.${kind}.annotated`, [`let xs: ${kind}[] = hostValue`], "sum(xs)");
        yield variant(`sum.${kind}.nullable-list`, [`let xs: ${kind}[]? = hostValue`], "sum(xs)");
      }
      yield variant("sum.nullable-elements", ["let xs: integer?[] = hostValue"], "sum(xs)");
      yield variant("sum.set-annotated", ["let xs: integer set = hostValue"], "sum(xs)");
      yield variant("sum.set-literal", [], "sum(set [1, 2])");
      yield variant("sum.scalar", [], "sum(1)");
      yield variant("sum.text", [], 'sum("x")');
      yield variant("sum.list-or-string", ["let xs: integer[] | string = hostValue"], "sum(xs)");
      yield variant("sum.bare-list", ["let xs: list = hostValue"], "sum(xs)");
      yield parameterVariant("sum.parameter", "sum(p)", "[1, 2]");
      yield variant("percentile.host-percent", [], "percentile([1, 2], hostValue)", "host");
      yield variant("percentile.text-percent", [], 'percentile([1, 2], "x")');
      yield variant("percentile.negative-percent", [], "percentile([1, 2], -1)");
      yield variant("percentile.host-list-text-percent", [], 'percentile(hostList, "x")', "host");
      yield variant(
        "percentile.host-element-negative-percent",
        [],
        "percentile([hostValue], -1)",
        "host",
      );
      yield variant(
        "percentile.host-list-and-percent",
        [],
        "percentile([hostValue], hostValue)",
        "host",
      );
      yield variant("percentile.no-percent", [], "percentile([1, 2])");
      yield variant("percentile.extra-positional", [], "percentile([1, 2], 50, 3)");
      yield variant("sum.extra-named", [], "sum([1], extra: 1)");
      yield variant("sum.extra-positional", [], "sum([1], 2)");
      yield variant("sum.no-arguments", [], "sum()");
      yield variant("min.extra-named-list", [], "min([1, 2], extra: 1)");
      yield variant(
        "sum.mixed-allowed-kinds",
        ["let xs: (integer | duration)[] = hostValue"],
        "sum(xs)",
      );
      yield variant(
        "sum.text-or-null-elements",
        ["let xs: (string | null)[] = hostValue"],
        "sum(xs)",
      );
      yield variant("sum.null-elements", [], "sum([null])");
      yield variant("sum.null-list", [], "sum(null)");
      for (const name of STATISTICS)
        for (const kind of WRITTEN_KINDS)
          if (name !== "sum")
            yield variant(
              `${name}.${kind}.annotated`,
              [`let xs: ${kind}[] = hostValue`],
              `${name}(xs)`,
            );
    },
  },
  {
    id: "selector",
    *variants() {
      for (const kind of LITERAL_KINDS)
        yield variant(
          `sum.${kind}`,
          [],
          `sum([{ p: ${literal(kind)} }, { p: ${literal(kind, true)} }], by: "p")`,
        );
      for (const name of STATISTICS)
        yield variant(`${name}.objects`, [], `${name}([{ p: 1 }, { p: 2 }], by: "p")`);
      yield variant("percentile.objects", [], 'percentile([{ p: 1 }, { p: 2 }], 50, by: "p")');
      yield variant("missing", [], 'sum([{ p: 1 }], by: "q")');
      yield variant("variable", ['let k = "p"'], "sum([{ p: 1 }], by: k)");
      yield variant("host", [], "sum([{ p: 1 }], by: hostText)", "host");
      yield variant("number", [], "sum([{ p: 1 }], by: 1)");
      yield variant("scalars", [], 'sum([1, 2], by: "p")');
      yield variant("objects-variable", ["let xs = [{ p: 1 }, { p: 2 }]"], 'sum(xs, by: "p")');
      yield variant("host-list", [], 'sum(hostList, by: "p")', "host");
      yield variant("some-missing", [], 'sum([{ p: 1 }, { q: 2 }], by: "p")');
      yield variant("host-property", [], 'sum([{ p: hostValue }], by: "p")', "host");
      yield variant("object-and-scalar", [], 'sum([{ p: 1 }, 2], by: "p")');
      yield variant("nested-property", [], 'sum([{ p: { q: 1 } }], by: "p")');
      yield variant(
        "optional-property",
        ["let v: integer? = hostValue"],
        'sum([{ p: v }], by: "p")',
      );
      yield variant("bare-objects", ["let xs: object[] = hostValue"], 'sum(xs, by: "p")');
      yield variant("null-selector", [], "sum([{ null: 1 }], by: null)");
      yield variant("host-list-variable-selector", ['let k = "p"'], "sum(hostList, by: k)", "host");
      yield variant("host-list-host-selector", [], "sum(hostList, by: hostText)", "host");
      yield variant("host-list-number-selector", [], "sum(hostList, by: 1)", "host");
      yield variant("null-selector-plain", [], "sum([{ p: 1 }], by: null)");
      yield variant("nullable-selector", ["let k: string? = hostValue"], "sum([{ p: 1 }], by: k)");
      yield variant("empty-list", [], 'sum([], by: "p")');
      yield variant("null-elements", [], 'sum([null], by: "p")');
      yield variant("extra-named", [], 'sum([{ p: 1 }], by: "p", extra: 1)');
      yield parameterVariant("parameter", 'sum(p, by: "p")', "[{ p: 1 }]");
    },
  },
];

const POINTS = "[{ x: 1, y: 2 }, { x: 2, y: 3 }]";

export const REGRESSION_TEMPLATES: readonly Template[] = [
  {
    id: "points",
    *variants() {
      yield variant("plain", [], `linearRegression(${POINTS})`);
      yield variant("one-point", [], "linearRegression([{ x: 1, y: 2 }])");
      yield variant("empty", [], "linearRegression([])");
      yield variant("selectors", [], `linearRegression(${POINTS}, x: "x", y: "y")`);
      yield variant(
        "other-names",
        [],
        'linearRegression([{ a: 1, b: 2 }, { a: 2, b: 3 }], x: "a", y: "b")',
      );
      yield variant("x-only", [], `linearRegression(${POINTS}, x: "x")`);
      yield variant("y-only", [], `linearRegression(${POINTS}, y: "y")`);
      yield variant("x-variable", ['let k = "x"'], `linearRegression(${POINTS}, x: k, y: "y")`);
      yield variant("x-host", [], `linearRegression(${POINTS}, x: hostText, y: "y")`, "host");
      yield variant("x-number", [], `linearRegression(${POINTS}, x: 1, y: "y")`);
      yield variant("missing-selector", [], `linearRegression(${POINTS}, x: "a", y: "y")`);
      yield variant("numbers", [], "linearRegression([1, 2])");
      yield variant("scalar", [], "linearRegression(1)");
      yield variant("texts", [], 'linearRegression(["a", "b"])');
      yield variant("decimal-points", [], "linearRegression([{ x: 1.5, y: 2 }, { x: 2.5, y: 3 }])");
      yield variant("duration-x", [], "linearRegression([{ x: 1 s, y: 2 }, { x: 2 s, y: 3 }])");
      yield variant("duration-y", [], "linearRegression([{ x: 1, y: 2 s }, { x: 2, y: 3 s }])");
      yield variant("text-y", [], 'linearRegression([{ x: 1, y: "a" }])');
      yield variant("text-x", [], 'linearRegression([{ x: "a", y: 1 }])');
      yield variant("host-x", [], "linearRegression([{ x: hostValue, y: 1 }])", "host");
      yield variant("host-points", [], "linearRegression(hostList)", "host");
      yield variant("host-element", [], "linearRegression([hostValue])", "host");
      yield variant("variable", [`let ps = ${POINTS}`], "linearRegression(ps)");
      yield variant("annotated", ["let ps: object[] = hostValue"], "linearRegression(ps)");
      yield variant(
        "narrowed",
        [`let ps = ${POINTS}`, "let qs: object[]? = ps"],
        "linearRegression(qs)",
      );
      yield variant("nullable", ["let ps: object[]? = hostValue"], "linearRegression(ps)");
      yield variant("extra-named", [], "linearRegression([1, 2], extra: 1)");
      yield variant("extra-positional", [], "linearRegression([1, 2], 3)");
      yield variant("no-arguments", [], "linearRegression()");
      yield variant("durations", [], "linearRegression([1 s, 2 s])");
      yield variant("decimals", [], "linearRegression([1.5, 2.5])");
      yield variant("one-number", [], "linearRegression([1])");
      yield variant("empty-selected", [], 'linearRegression([], x: "x", y: "y")');
      for (const kind of LITERAL_KINDS) {
        yield variant(
          `x.${kind}`,
          [],
          `linearRegression([{ x: ${literal(kind)}, y: 2 }, { x: ${literal(kind, true)}, y: 3 }], x: "x", y: "y")`,
        );
        yield variant(
          `y.${kind}`,
          [],
          `linearRegression([{ x: 1, y: ${literal(kind)} }, { x: 2, y: ${literal(kind, true)} }], x: "x", y: "y")`,
        );
      }
      for (const kind of WRITTEN_KINDS) {
        yield variant(
          `x.${kind}.annotated`,
          [`let v: ${kind} = hostValue`],
          'linearRegression([{ x: v, y: 1 }, { x: v, y: 2 }], x: "x", y: "y")',
        );
        yield variant(
          `y.${kind}.annotated`,
          [`let v: ${kind} = hostValue`],
          'linearRegression([{ x: 1, y: v }, { x: 2, y: v }], x: "x", y: "y")',
        );
      }
      yield variant(
        "x.nullable",
        ["let v: integer? = hostValue"],
        'linearRegression([{ x: v, y: 1 }], x: "x", y: "y")',
      );
      yield variant(
        "y.nullable",
        ["let v: integer? = hostValue"],
        'linearRegression([{ x: 1, y: v }], x: "x", y: "y")',
      );
      yield variant(
        "x.host-values",
        [],
        'linearRegression([{ x: hostValue, y: 1 }], x: "x", y: "y")',
        "host",
      );
      yield variant("objects-for-y", [], 'linearRegression([1, 2], y: "y")');
      yield variant(
        "mixed-allowed-kinds",
        ["let ys: (integer | duration)[] = hostValue"],
        "linearRegression(ys)",
      );
      yield variant(
        "x.mixed-allowed-kinds",
        ["let v: integer | date = hostValue"],
        'linearRegression([{ x: v, y: 1 }], x: "x", y: "y")',
      );
      yield parameterVariant("parameter", "linearRegression(p)", POINTS);
    },
  },
];

export const PREDICTION_TEMPLATES: readonly Template[] = [
  {
    id: "line",
    *variants() {
      const line = (slope: string, intercept: string, start: string) =>
        `{ slope: ${slope}, intercept: ${intercept}, start: ${start} }`;
      for (const kind of LITERAL_KINDS)
        yield variant(`intercept.${kind}`, [], `predict(${line("1", literal(kind), "0")}, 1)`);
      for (const kind of LITERAL_KINDS)
        yield variant(`slope.${kind}`, [], `predict(${line(literal(kind), "2", "0")}, 1)`);
      for (const kind of LITERAL_KINDS)
        yield variant(`start.${kind}`, [], `predict(${line("1", "2", literal(kind))}, 1)`);
      for (const kind of LITERAL_KINDS)
        yield variant(`x.${kind}`, [], `predict(${line("1", "2", "0")}, ${literal(kind)})`);
      yield variant("intercept.host", [], `predict(${line("1", "hostValue", "0")}, 1)`, "host");
      yield variant("slope.host", [], `predict(${line("hostValue", "2", "0")}, 1)`, "host");
      yield variant("start.host", [], `predict(${line("1", "2", "hostValue")}, 1)`, "host");
      yield variant("x.host", [], `predict(${line("1", "2", "0")}, hostValue)`, "host");
      yield variant(
        "intercept.annotated",
        ["let i: integer = hostValue"],
        `predict(${line("1", "i", "0")}, 1)`,
      );
      yield variant(
        "intercept.nullable",
        ["let i: integer? = hostValue"],
        `predict(${line("1", "i", "0")}, 1)`,
      );
      yield variant(
        "intercept.duration-annotated",
        ["let i: duration = hostValue"],
        `predict(${line("1", "i", "0")}, 1)`,
      );
      yield variant("no-start", [], "predict({ slope: 1, intercept: 2 }, 1)");
      yield variant("no-intercept", [], "predict({ slope: 1, start: 0 }, 1)");
      yield variant("no-slope", [], "predict({ intercept: 2, start: 0 }, 1)");
      yield variant(
        "extra",
        [],
        `predict(${line("1", "2", "0")}, 1)`.replace("start: 0 }", "start: 0, extra: 1 }"),
      );
      yield variant("empty", [], "predict({}, 1)");
      yield variant("regression", [`let l = linearRegression(${POINTS})`], "predict(l, 1)");
      yield variant(
        "regression-durations",
        ["let l = linearRegression([{ x: 1 s, y: 2 }, { x: 2 s, y: 3 }])"],
        "predict(l, 3 s)",
      );
      yield variant(
        "regression-duration-y",
        ["let l = linearRegression([{ x: 1, y: 2 s }, { x: 2, y: 3 s }])"],
        "predict(l, 3)",
      );
      yield variant("variable", [`let l = ${line("1", "2", "0")}`], "predict(l, 1)");
      yield variant("annotated", ["let l: object = hostValue"], "predict(l, 1)");
      yield variant("host", [], "predict(hostValue, 1)", "host");
      yield variant("scalar", [], "predict(1, 1)");
      yield variant("text", [], 'predict("a", 1)');
      yield variant("list", [], "predict([1], 1)");
      yield variant("no-x", [], `predict(${line("1", "2", "0")})`);
      yield variant("extra-named", [], `predict(${line("1", "2", "0")}, 1, extra: 1)`);
      yield variant("extra-positional", [], `predict(${line("1", "2", "0")}, 1, 2)`);
      yield variant("no-arguments", [], "predict()");
      yield variant(
        "date-x-and-start",
        ["let d: date = hostValue"],
        `predict(${line("1", "2", "d")}, d)`,
      );
      yield variant(
        "date-start-number-x",
        ["let d: date = hostValue"],
        `predict(${line("1", "2", "d")}, 1)`,
      );
      yield variant("duration-x-and-start", [], `predict(${line("1", "2 s", "1 s")}, 3 s)`);
      yield variant(
        "nullable-x",
        ["let n: integer? = hostValue"],
        `predict(${line("1", "2", "0")}, n)`,
      );
      yield variant("null-x", [], `predict(${line("1", "2", "0")}, null)`);
      yield variant(
        "narrowed-line",
        [`let l = ${line("1", "2", "0")}`, "let m: object? = l"],
        "predict(m, 1)",
      );
      yield variant("nullable-line", ["let m: object? = hostValue"], "predict(m, 1)");
      yield variant(
        "host-intercept-date-start",
        ["let d: date = hostValue"],
        `predict(${line("1", "hostValue", "d")}, 1)`,
        "host",
      );
      yield variant(
        "object-line-host-x",
        ["let l: object = hostValue"],
        "predict(l, hostValue)",
        "host",
      );
      yield parameterVariant("parameter", "predict(p, 1)", line("1", "2", "0"));
    },
  },
];
