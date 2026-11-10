import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import Color from "colorjs.io";
import { compileSource } from "../../src/compiler.js";
import { isNormalizedColor, isNormalizedOpaqueColor, normalizeColor } from "../../src/color.js";
import { authoredColorToOklch } from "../../player/theme/color.js";
import { exactOperationEscapes } from "../helpers/exact-operations.js";

/*
 * Colours normalize to the same text in every JavaScript engine (#2147): `src/color.ts` converts with operations
 * ECMAScript specifies exactly and prints with its own formatter. Clause by clause: agreement with colorjs.io's own
 * conversion within its accurate domain and the same rejections (2, 7), the pinned stored text (5), the formatter (6),
 * and the closed admission over the conversion's files with a run under throwing `Math` members (1).
 */

function oklchCoordinates(color: string): number[] {
  const match = /^oklch\((.*)\)$/u.exec(color);
  assert.ok(match !== null, color);
  return match[1]!.trim().split(/\s+/u).map(Number);
}

/** Integer steps only, so every engine builds the same inputs. */
function colourInputs(
  seed: number,
  count: number,
  make: (next: (low: number, high: number, scale: number) => number) => string,
): string[] {
  let state = seed;
  const next = (low: number, high: number, scale: number) => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return (low + (state % (high - low + 1))) / scale;
  };
  return Array.from({ length: count }, () => make(next));
}

/**
 * One family per space id `toOklch` converts, within ten times each reference range and hues of two turns either way:
 * colorjs.io turns a hue into radians before reducing it, which loses about C × |h| × 2^-53 for larger hues.
 */
const NOTATION_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  srgb: [
    ...colourInputs(
      1,
      400,
      (n) => `#${[0, 0, 0].map(() => n(0, 255, 1).toString(16).padStart(2, "0")).join("")}`,
    ),
    ...colourInputs(
      2,
      200,
      (n) => `rgb(${n(0, 100000, 1000)}% ${n(0, 100000, 1000)}% ${n(0, 100000, 1000)}%)`,
    ),
    "red",
    "seagreen",
    "#000005",
  ],
  hsl: colourInputs(
    3,
    300,
    (n) => `hsl(${n(-36000, 36000, 10)} ${n(0, 1000, 10)}% ${n(0, 1000, 10)}%)`,
  ),
  hwb: colourInputs(
    4,
    300,
    (n) => `hwb(${n(-36000, 36000, 10)} ${n(0, 1000, 10)}% ${n(0, 1000, 10)}%)`,
  ),
  lab: colourInputs(
    5,
    300,
    (n) => `lab(${n(0, 10000, 100)} ${n(-125000, 125000, 100)} ${n(-125000, 125000, 100)})`,
  ),
  lch: colourInputs(
    6,
    300,
    (n) => `lch(${n(0, 10000, 100)} ${n(0, 150000, 100)} ${n(-7200, 7200, 10)})`,
  ),
  oklab: colourInputs(
    7,
    300,
    (n) => `oklab(${n(0, 1000, 1000)} ${n(-4000, 4000, 1000)} ${n(-4000, 4000, 1000)})`,
  ),
  oklch: colourInputs(
    8,
    300,
    (n) => `oklch(${n(0, 1000, 1000)} ${n(0, 4000, 1000)} ${n(-7200, 7200, 10)})`,
  ),
};

/** Each channel of each notation at magnitudes up to the largest double, where some of today's inputs overflow. */
const EXTREME_INPUTS: readonly string[] = (() => {
  const magnitudes = [
    "1e-320",
    "5e-324",
    "1e-300",
    "1e-15",
    "1e15",
    "1e100",
    "1e300",
    "1e305",
    "5.7e307",
    "5.8e307",
    "1.7976931348623157e308",
  ];
  const values = ["0", ...magnitudes.flatMap((m) => [m, `-${m}`])];
  const forms: readonly [string, readonly string[], string][] = [
    ["rgb", ["128", "64", "32"], ""],
    ["rgb", ["50", "25", "10"], "%"],
    ["hsl", ["30", "50%", "50%"], ""],
    ["hwb", ["30", "10%", "10%"], ""],
    ["lab", ["50", "20", "-30"], ""],
    ["lch", ["50", "40", "30"], ""],
    ["oklab", ["0.5", "0.1", "-0.1"], ""],
    ["oklch", ["0.5", "0.1", "30"], ""],
  ];
  return forms.flatMap(([name, channels, unit]) =>
    [0, 1, 2].flatMap((channel) =>
      values.map((value) => {
        const parts = channels.map((part, index) =>
          index === channel ? `${value}${part.endsWith("%") ? "%" : unit}` : `${part}${unit}`,
        );
        return `${name}(${parts.join(" ")})`;
      }),
    ),
  );
})();

/** colorjs.io's own conversion, as `normalizeColor` did it before it converted itself: the reference of clauses 2 and 7. */
function colorjsOklch(source: string): readonly number[] | null {
  try {
    const parsed = new Color(source);
    if (
      parsed.alpha !== 1 ||
      ![...parsed.coords, parsed.alpha].every((c) => c === null || Number.isFinite(c))
    )
      return null;
    const clamp = (index: 0 | 1 | 2, upper: number) => {
      parsed.coords[index] = Math.min(upper, Math.max(0, parsed.coords[index] ?? 0));
    };
    const id = parsed.space.id;
    if (id === "srgb") for (const index of [0, 1, 2] as const) clamp(index, 1);
    if (id === "hsl" || id === "hwb") {
      clamp(1, 100);
      clamp(2, 100);
    }
    if (id === "lab" || id === "lch") clamp(0, 100);
    if (id === "oklab" || id === "oklch") clamp(0, 1);
    if (id === "lch" || id === "oklch") clamp(1, Infinity);
    const coordinates = parsed.to("oklch").coords.map((c) => c ?? 0);
    return coordinates.every((c) => Number.isFinite(c)) ? coordinates : null;
  } catch {
    return null;
  }
}

test("normalizes each notation as colorjs.io does, rejects exactly what it rejects, and pins the stored text", () => {
  const oklab = ([l, c, h]: readonly number[]) => [
    l!,
    c! * Math.cos((h! * Math.PI) / 180),
    c! * Math.sin((h! * Math.PI) / 180),
  ];
  for (const [space, inputs] of Object.entries(NOTATION_FAMILIES))
    for (const input of inputs) {
      const reference = colorjsOklch(input);
      const normalized = normalizeColor(input);
      assert.equal(normalized === null, reference === null, input);
      if (reference === null) continue;
      assert.equal(new Color(input).space.id, space, input);
      const found = oklab(oklchCoordinates(normalized!));
      oklab(reference).forEach((value, index) =>
        assert.ok(Math.abs(value - found[index]!) <= 1e-12, `${input}: ${normalized}`),
      );
    }
  // Beyond two turns the reference loses accuracy; degrees reduce exactly, so a whole hue gives its remainder's colour.
  for (const hue of [721, 1e6 + 7, 2 ** 40 + 90, 1e15 + 270, 9007199254740991])
    assert.equal(
      normalizeColor(`lch(60 40 ${hue})`),
      normalizeColor(`lch(60 40 ${hue % 360})`),
      String(hue),
    );
  assert.equal(normalizeColor("lch(50 20 1e308)"), null);
  // The stored contract: a change to these strings changes checkpoints and needs the format revisions to move.
  assert.deepEqual(
    [
      "#000005",
      "blue",
      "rgb(12.5% 50% 99%)",
      "hsl(200 50% 40%)",
      "hwb(120 10% 20%)",
      "lab(50 20 -30)",
      "lch(60 40 300)",
      "oklab(0.5 0.1 -0.1)",
      "oklch(0.5 0.1 30)",
    ].map(normalizeColor),
    [
      "oklch(0.0519446373783983 0.0359940576693666 264.05202261637)",
      "oklch(0.452013718174424 0.313214388634485 264.05202261637)",
      "oklch(0.615643431497595 0.205008125043922 257.648668651491)",
      "oklch(0.540606009064048 0.0862925138728462 233.328902301576)",
      "oklch(0.734518166561144 0.242191195516654 142.608208613927)",
      "oklch(0.580208411297114 0.0972230595785066 301.76915836368)",
      "oklch(0.667074854306809 0.107343926994054 297.247169116516)",
      "oklch(0.5 0.14142135623731 315)",
      "oklch(0.5 0.1 30)",
    ],
  );
});

/** Whether a printed component reads back as a finite double that prints the same text again (as an OKLCH hue, which
 * is printed without conversion). */
function printsAgain(component: string): boolean {
  return (
    Number.isFinite(Number(component)) &&
    normalizeColor(`oklch(0 0 ${component})`) === `oklch(0 0 ${component})`
  );
}

test("prints 15 significant digits (17 near the largest double), each reading back finite and printing again the same", () => {
  // Value rows: authored decimals of at most 15 digits print as written; the rest round at 15 digits.
  const rows: readonly (readonly [string, string])[] = [
    ["oklch(0.5 0.1 120)", "oklch(0.5 0.1 120)"],
    ["oklch(0 0 2.9802322387695312e-8)", "oklch(0 0 2.98023223876953e-8)"],
    ["oklch(0 0 7.120236347223045e-307)", "oklch(0 0 7.12023634722304e-307)"],
    ["oklch(0.5 1e124 30)", "oklch(0.5 1e+124 30)"],
    ["oklch(0.5 1e-7 30)", "oklch(0.5 1e-7 30)"],
    ["oklch(0 0 -0)", "oklch(0 0 0)"],
    ["oklch(0 0 5e-324)", "oklch(0 0 4.94065645841247e-324)"],
    // Above 1.79769313486231e308, 15 digits would read back as Infinity; 17 always read back.
    ["oklch(0.5 1.7976931348623157e308 0)", "oklch(0.5 1.7976931348623157e+308 0)"],
    ["oklch(0.5 1.79769313486231e308 0)", "oklch(0.5 1.79769313486231e+308 0)"],
    // Values a reader sees at the 16th digit (judged neutral): a huge hue, and two neutral thresholds of the Player.
    ["oklch(0.5 0.1 1.0000000000000002e20)", "oklch(0.5 0.1 1e+20)"],
    ["oklch(0.9999999999999999 0.1 30)", "oklch(1 0.1 30)"],
    ["oklch(0.5 9.999999999999998e-8 30)", "oklch(0.5 1e-7 30)"],
  ];
  for (const [input, printed] of rows) assert.equal(normalizeColor(input), printed, input);
  // The property, over notation × component × magnitude, both signs: each printed component reads back finite and prints
  // again the same, and each printed colour passes the validators and the Player's reader.
  const magnitudes = [
    "5e-324",
    "1e-320",
    "2.2250738585072014e-308",
    "1e-300",
    "1e-100",
    "1e-15",
    "1e-7",
    "0.1",
    "1",
    "1e15",
    "1e21",
    "1e100",
    "1e300",
    "1.79769313486231e308",
    "1.7976931348623101e308",
    "1.797693134862315e308",
    "1.7976931348623157e308",
  ];
  const covered = new Set<string>();
  for (const [notation, channels] of NOTATIONS)
    for (const [index, [channel]] of channels.entries())
      for (const magnitude of magnitudes)
        for (const sign of ["", "-"]) {
          const values = channels.map(([, value, unit], at) =>
            at === index ? `${sign}${magnitude}${unit}` : `${value}${unit}`,
          );
          const printed = normalizeColor(`${notation}(${values.join(" ")})`);
          if (printed === null) continue;
          covered.add(`${notation} ${channel}`);
          for (const component of /^oklch\((.*)\)$/u.exec(printed)![1]!.split(" "))
            assert.ok(printsAgain(component), `${printed}: ${component}`);
          assert.ok(isNormalizedColor(printed) && isNormalizedOpaqueColor(printed), printed);
          assert.doesNotThrow(() => authoredColorToOklch(printed), printed);
        }
  for (const [notation, channels] of NOTATIONS)
    for (const [channel] of channels)
      assert.ok(covered.has(`${notation} ${channel}`), `${notation} ${channel}`);
  // Whole-colour re-normalization is not claimed: a converted lightness outside [0, 1] is clamped when the text is
  // parsed again (#2280).
  const below = normalizeColor("lab(0 10 20)")!;
  assert.ok(oklchCoordinates(below)[0]! < 0);
  assert.notEqual(normalizeColor(below), below);
});

test("converts with no host transcendental, colorjs.io's parsing included", () => {
  const exact = new Set(["abs", "ceil", "floor", "max", "min", "round", "sign", "sqrt", "trunc"]);
  const saved = new Map<string, PropertyDescriptor>();
  // Counted as well as thrown: colorjs.io's parse and `parseColor` catch exceptions, which would hide an attempt.
  const attempts: string[] = [];
  for (const name of Object.getOwnPropertyNames(Math)) {
    const descriptor = Object.getOwnPropertyDescriptor(Math, name)!;
    if (typeof descriptor.value === "function" && !exact.has(name)) {
      saved.set(name, descriptor);
      Object.defineProperty(Math, name, {
        ...descriptor,
        value: () => {
          attempts.push(name);
          throw new Error(`Math.${name} was called`);
        },
      });
    }
  }
  const parsing = [
    "hsl(1rad 50% 50%)",
    "hsl(200grad 50% 50%)",
    "hsl(.5turn 50% 50%)",
    "hsl(30deg 50% 50%)",
    "lch(50% 40% 30deg)",
    "oklch(50% 50% 1rad)",
    "rgb(255 0 0 / 1)",
    "rgba(255, 0, 0, 1)",
    "#ff0000ff",
    "lab(50% 20% -30%)",
  ];
  try {
    for (const input of [...Object.values(NOTATION_FAMILIES).flat(), ...EXTREME_INPUTS, ...parsing])
      normalizeColor(input);
  } finally {
    for (const [name, descriptor] of saved) Object.defineProperty(Math, name, descriptor);
  }
  assert.deepEqual(attempts, []);
});

test("the colour conversion admits only operations whose results the specification fixes", () => {
  assert.deepEqual(exactOperationEscapes(), []);
  // Each form outside the admission is an escape: an addition to a file, or a replacement in it.
  const source = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");
  const added = (file: string, addition: string) => ({ [file]: `${source(file)}\n${addition}\n` });
  const replaced = (file: string, from: string, to: string) => {
    const text = source(file);
    assert.equal(text.split(from).length, 2, from);
    return { [file]: text.replace(from, to) };
  };
  const RETURN =
    "return `oklch(${formatNumber(lightness)} ${formatNumber(chroma)} ${formatNumber(hue)})`;";
  const PRINT = "x.toPrecision(15)";
  const OKLAB = "  const degrees = finiteAtan2(b, a);";
  const PARSE = "    const parsed = new Color(source);";
  for (const [label, overrides] of [
    // The earlier families.
    ["a non-exact Math member", replaced("src/color.ts", OKLAB, `${OKLAB}\n  void Math.cbrt(2);`)],
    ["an element access of Math", added("src/color.ts", 'export const a = () => Math["sqrt"](2);')],
    [
      "an alias of Math",
      added("src/color.ts", "const m = Math;\nexport const a = () => m.sqrt(2);"),
    ],
    [
      "a destructured Math",
      added("src/color.ts", "const { sqrt } = Math;\nexport const a = () => sqrt(2);"),
    ],
    [
      "a Math member as a value",
      added("src/color.ts", "export const a = () => [1].map(Math.floor);"),
    ],
    [
      "globalThis",
      replaced(
        "src/deterministic-math.ts",
        "  const third = Math.floor(exponent / 3);",
        "  const third = globalThis.Math.floor(exponent / 3);",
      ),
    ],
    ["** on numbers", added("src/color.ts", "export const a = (x: number) => x ** 2;")],
    [
      "a colorjs.io conversion",
      replaced("src/color.ts", PARSE, `${PARSE}\n    void new Color(source).to("oklch");`),
    ],
    [
      "a parsed colorjs.io object's method",
      replaced("src/color.ts", PARSE, `${PARSE}\n    void parsed.to("oklch");`),
    ],
    [
      "a widened colorjs.io object",
      replaced(
        "src/color.ts",
        PARSE,
        `${PARSE}\n    const widened: Pick<Color, "to"> = parsed;\n    void widened.to("oklch");`,
      ),
    ],
    [
      "[x].join in the closure",
      replaced("src/color.ts", OKLAB, `${OKLAB}\n  void [degrees].join("");`),
    ],
    [
      "a computed key with for…in in the closure",
      replaced(
        "src/color.ts",
        OKLAB,
        `${OKLAB}\n  for (const key in { [degrees]: true }) void key;`,
      ),
    ],
    [
      "a colorjs.io import into numeric-functions",
      added(
        "src/numeric-functions.ts",
        'import Color from "colorjs.io";\nexport const escaped = (s: string) => new Color(s).to("oklch");',
      ),
    ],
    [
      "a local formatNumber shadow",
      replaced(
        "src/color.ts",
        RETURN,
        `function formatNumber(x: number): string {\n    return x === 0 ? '0' : '1';\n  }\n  ${RETURN}`,
      ),
    ],
    [
      "a helper in the text module",
      added(
        "src/color-text.ts",
        "export function helper(x: number): string {\n  return `${x}`;\n}",
      ),
    ],
    ["String in the text module", replaced("src/color-text.ts", PRINT, "String(x)")],
    // The design round's.
    ["toExponential without precision", replaced("src/color-text.ts", PRINT, "x.toExponential()")],
    [
      "a long decimal read back",
      replaced("src/color.ts", OKLAB, `${OKLAB}\n  void Number("0.100000000000000012491");`),
    ],
    [
      "a NaN stored outside decompose",
      replaced(
        "src/color.ts",
        OKLAB,
        `${OKLAB}\n  new DataView(new ArrayBuffer(8)).setFloat64(0, Infinity - Infinity);`,
      ),
    ],
    [
      "a number as a computed key",
      replaced("src/color.ts", OKLAB, `${OKLAB}\n  void { [degrees]: 1 };`),
    ],
    // The precision controls.
    ["toPrecision without an argument", replaced("src/color-text.ts", PRINT, "x.toPrecision()")],
    ["toPrecision(undefined)", replaced("src/color-text.ts", PRINT, "x.toPrecision(undefined)")],
    [
      "toPrecision with a variable",
      replaced("src/color-text.ts", PRINT, "x.toPrecision(x > 1 ? 15 : 16)"),
    ],
    ["toPrecision(16)", replaced("src/color-text.ts", PRINT, "x.toPrecision(16)")],
    ["toFixed", replaced("src/color-text.ts", PRINT, "x.toFixed(3)")],
    // The closure's own.
    [
      "a helper the closure calls, with an unadmitted call",
      {
        "src/color.ts": `${replaced("src/color.ts", OKLAB, `${OKLAB}\n  unchecked();`)["src/color.ts"]!}\nfunction unchecked(): void {\n  void [1].join("");\n}\n`,
      },
    ],
    ["a free host-property read", replaced("src/color.ts", OKLAB, `${OKLAB}\n  void Date.now();`)],
    [
      "a write to a support table",
      added(
        "src/numeric-functions.ts",
        "export function spoil(): void {\n  (ONE as { hi: number }).hi = 2;\n}",
      ),
    ],
    [
      "a reassigned closure function",
      added(
        "src/deterministic-math.ts",
        "export function spoil(): void {\n  // @ts-expect-error a reassignment\n  decompose = () => [0, 0];\n}",
      ),
    ],
    // The float-storage primitive and the finite wrappers.
    [
      "a NaN stored inside decompose",
      replaced(
        "src/deterministic-math.ts",
        "view.setFloat64(0, subnormal ? x * 4503599627370496 : x, false);",
        "view.setFloat64(0, Infinity - Infinity, false);",
      ),
    ],
    [
      "a wrapper without its finite check",
      replaced(
        "src/color.ts",
        "  if (!Number.isFinite(x)) return Number.NaN;\n  return cubeRoot(x);",
        "  return cubeRoot(x);",
      ),
    ],
  ] as const)
    assert.notDeepEqual(exactOperationEscapes(overrides), [], label);
});

/**
 * Clause 7's family: each channel of each notation over a ladder of magnitudes, at hues up to the largest finite
 * radians. The bound 1e100 is derived: below it no intermediate can overflow (Lab's cube needs |a|/500 or |b|/200
 * above about 5.6e102, so a coordinate of about 1e105; the matrices' row sums stay under 1.4; OKLab's square needs about
 * 1.3e154), so both conversions accept; the smallest difference measured (26,544 inputs) is at 1e106. It is the
 * claim's edge, not a limit on what a script may write: beyond it, acceptance follows the exact arithmetic, the same in
 * every engine, and may differ from colorjs.io's either way.
 */
const BOUND = 1e100;
const WITHIN = ["0", "5e-324", "1e-320", "1e-300", "1e-15", "1", "1e15", "1e50", "1e100"].flatMap(
  (m) => (m === "0" ? [m] : [m, `-${m}`]),
);
const BEYOND = ["1e102", "1e106", "1e124", "1e200", "1e300", "1.7976931348623157e308"].flatMap(
  (m) => [m, `-${m}`],
);
const HUES = [
  "30",
  "90",
  "192",
  "1e17",
  "100000000000001000",
  "1e20",
  "1e100",
  "1e300",
  "5.7e307",
  "5.8e307",
];
/** Each notation's channels as [name, base value, unit]; the hue channel is the one named `hue`. */
const NOTATIONS: readonly (readonly [string, readonly (readonly [string, string, string])[]])[] = [
  [
    "rgb",
    [
      ["red", "128", ""],
      ["green", "64", ""],
      ["blue", "32", ""],
    ],
  ],
  [
    "rgb",
    [
      ["red", "50", "%"],
      ["green", "25", "%"],
      ["blue", "10", "%"],
    ],
  ],
  [
    "hsl",
    [
      ["hue", "30", ""],
      ["saturation", "50", "%"],
      ["lightness", "50", "%"],
    ],
  ],
  [
    "hwb",
    [
      ["hue", "30", ""],
      ["whiteness", "10", "%"],
      ["blackness", "10", "%"],
    ],
  ],
  [
    "lab",
    [
      ["lightness", "50", ""],
      ["a", "20", ""],
      ["b", "-30", ""],
    ],
  ],
  [
    "lch",
    [
      ["lightness", "50", ""],
      ["chroma", "40", ""],
      ["hue", "30", ""],
    ],
  ],
  [
    "oklab",
    [
      ["lightness", "0.5", ""],
      ["a", "0.1", ""],
      ["b", "-0.1", ""],
    ],
  ],
  [
    "oklch",
    [
      ["lightness", "0.5", ""],
      ["chroma", "0.1", ""],
      ["hue", "30", ""],
    ],
  ],
];

test("accepts what colorjs.io accepts wherever no intermediate can overflow, and only differs beyond 1e100", () => {
  const covered = new Set<string>();
  const differences: { readonly input: string; readonly accepted: boolean }[] = [];
  for (const [notation, channels] of NOTATIONS) {
    const hueIndex = channels.findIndex(([channel]) => channel === "hue");
    for (const [index, [channel]] of channels.entries())
      for (const magnitude of [...WITHIN, ...BEYOND])
        for (const hue of hueIndex < 0 || hueIndex === index ? [null] : HUES) {
          const values = channels.map(([, value, unit], at) =>
            at === index
              ? `${magnitude}${unit}`
              : at === hueIndex && hue !== null
                ? hue
                : `${value}${unit}`,
          );
          const input = `${notation}(${values.join(" ")})`;
          const nonHue = values
            .filter((_, at) => at !== hueIndex)
            .map((value) => Math.abs(Number.parseFloat(value)));
          const same = (normalizeColor(input) === null) === (colorjsOklch(input) === null);
          if (nonHue.every((value) => value <= BOUND)) {
            assert.ok(same, input);
            covered.add(`${notation} ${channel} ${magnitude} ${hue ?? "-"}`);
          } else if (!same) differences.push({ input, accepted: normalizeColor(input) !== null });
        }
  }
  // Coverage: every notation and channel at every magnitude within the bound, the hue channels over the hue set.
  for (const [notation, channels] of NOTATIONS)
    for (const [channel] of channels)
      for (const magnitude of WITHIN)
        assert.ok(
          [...covered].some((key) => key.startsWith(`${notation} ${channel} ${magnitude} `)),
          `${notation} ${channel} ${magnitude}`,
        );
  for (const hue of HUES)
    assert.ok(
      [...covered].some((key) => key.endsWith(` ${hue}`)),
      hue,
    );
  // Beyond the bound, where every input above has a non-hue coordinate, the two differ in both directions.
  assert.ok(differences.some(({ accepted }) => accepted));
  assert.ok(differences.some(({ accepted }) => !accepted));
});

test("pins the acceptance line through the compiler: the bound, and both directions beyond it", () => {
  const diagnostics = (color: string) =>
    compileSource(`say prose(color: "${color}") "x"\nexit`, {}).diagnostics.map(
      (diagnostic) => diagnostic.code,
    );
  // At the bound, each notation that can overflow accepts, as colorjs.io's conversion does.
  for (const color of [
    "lab(50 1e100 0)",
    "lab(50 0 -1e100)",
    "lch(50 1e100 30)",
    "oklab(0.5 1e100 0)",
    "oklab(0.5 0 -1e100)",
    "oklch(0.5 1e100 30)",
  ]) {
    assert.notEqual(colorjsOklch(color), null, color);
    assert.deepEqual(diagnostics(color), [], color);
  }
  // Beyond it: refused before and accepted now; accepted before and refused now; a hue whose radians are not finite.
  assert.deepEqual(diagnostics("lch(50 1e308 90)"), []);
  assert.deepEqual(diagnostics("lch(50 1e106 100000000000001000)"), ["TSC008"]);
  assert.deepEqual(diagnostics("lch(50 20 1e308)"), ["TSC008"]);
});
