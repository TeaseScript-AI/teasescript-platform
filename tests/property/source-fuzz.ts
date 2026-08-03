export const MAX_SOURCE_FUZZ_LENGTH = 512;
export const SOURCE_FUZZ_INSTRUCTION_BUDGET = 200;

export const VALID_SOURCE_FAMILIES = [
  "literals-expressions-ranges-templates",
  "variables-scope-and-collections",
  "conditions-and-loop-control",
  "functions-defaults-calls-and-recursion",
  "speakers-default-output-and-say-as",
  "deterministic-random-builtins",
] as const;

export const NEAR_VALID_SOURCE_FAMILIES = [
  "missing-declaration-identifier",
  "template-interpolation",
  "loop-control",
  "semantic-name",
  "function-arguments",
  "set-elements",
] as const;

export interface ValidSourceCase {
  readonly classification: "valid";
  readonly family: (typeof VALID_SOURCE_FAMILIES)[number];
  readonly variant: string;
  readonly source: string;
}

export interface NearValidSourceCase {
  readonly classification: "near-valid";
  readonly family: (typeof NEAR_VALID_SOURCE_FAMILIES)[number];
  readonly variant: string;
  readonly source: string;
  readonly diagnosticCodes: readonly string[];
}

export function createValidSourceCase(seed: number, index: number): ValidSourceCase {
  const choices = new SourceChoices(seed, index);
  const family = selectSourceFamily(VALID_SOURCE_FAMILIES, seed, index);

  switch (family) {
    case "literals-expressions-ranges-templates":
      return literalsSource(choices);
    case "variables-scope-and-collections":
      return collectionsSource(choices);
    case "conditions-and-loop-control":
      return controlFlowSource(choices);
    case "functions-defaults-calls-and-recursion":
      return functionsSource(choices);
    case "speakers-default-output-and-say-as":
      return speakersSource(choices);
    case "deterministic-random-builtins":
      return randomSource(choices);
  }
}

export function createNearValidSourceCase(seed: number, index: number): NearValidSourceCase {
  const choices = new SourceChoices(seed, index);
  const family = selectSourceFamily(NEAR_VALID_SOURCE_FAMILIES, seed, index);

  switch (family) {
    case "missing-declaration-identifier":
      return missingIdentifierCase(choices, family);
    case "template-interpolation":
      return missingTemplateExpressionCase(choices, family);
    case "loop-control":
      return outsideLoopCase(choices, family);
    case "semantic-name":
      return unknownNameCase(choices, family);
    case "function-arguments":
      return duplicateParameterCase(choices, family);
    case "set-elements":
      return compositeSetElementCase(choices, family);
  }
}

function literalsSource(choices: SourceChoices): ValidSourceCase {
  const start = choices.integer(1, 4);
  const rangeLength = choices.integer(1, 3);
  const operator = choices.pick(["+", "-"] as const);
  const text = choices.pick(["total", "sum", "value"] as const);
  return valid(
    "literals-expressions-ranges-templates",
    `start=${start} operator=${operator} range=${rangeLength} text=${text}`,
    [
      `let start = ${start}`,
      `let total = -start ${operator} 2 * 3`,
      `for item in start..=start + ${rangeLength} { total = total + item }`,
      `say \`${text}:\${total}\``,
    ],
  );
}

function collectionsSource(choices: SourceChoices): ValidSourceCase {
  const first = choices.integer(1, 4);
  const second = choices.integer(5, 8);
  const replacement = choices.integer(9, 12);
  const label = choices.pick(["kept", "saved", "copied"] as const);
  const setValues = choices.pick([
    '"a", "b", "a"', '"b", "a", "b"', '"c", "a", "c"',
  ] as const);
  return valid(
    "variables-scope-and-collections",
    `list=${first},${second} label=${label} set=${setValues}`,
    [
      `let source = [${first}, ${second}]`,
      "let copy = source",
      `copy[0] = ${replacement}`,
      `let record = { label: "${label}", values: set[${setValues}] }`,
      "for item in record.values { say `${record.label}:${item}` }",
      "say source[0]",
    ],
  );
}

function controlFlowSource(choices: SourceChoices): ValidSourceCase {
  const repeatCount = choices.integer(1, 4);
  const loopEnd = choices.integer(3, 4);
  const continueAt = choices.integer(1, loopEnd - 1);
  const target = choices.integer(8, 11);
  return valid(
    "conditions-and-loop-control",
    `repeat=${repeatCount} continue=${continueAt} break=${loopEnd} target=${target}`,
    [
      "let total = 0",
      `repeat ${repeatCount} { total = total + 1 }`,
      `for value in 1..=${loopEnd} {`,
      `  if value == ${continueAt} { continue }`,
      `  if value == ${loopEnd} { break }`,
      "  total = total + value",
      "}",
      `while total < ${target} { total = total + 1 }`,
      `if total == ${target} { say "done" } else { say "wrong" }`,
    ],
  );
}

function functionsSource(choices: SourceChoices): ValidSourceCase {
  const count = choices.integer(1, 4);
  const defaultStep = choices.integer(1, 3);
  const callStyle = choices.pick(["default", "positional", "named"] as const);
  const prefix = choices.pick(["count", "sum", "result"] as const);
  const call = countCall(callStyle, count, defaultStep);
  return valid(
    "functions-defaults-calls-and-recursion",
    `count=${count} default=${defaultStep} call=${callStyle} prefix=${prefix}`,
    [
      `function count(value, step = ${defaultStep}) {`,
      "  if value <= 0 { return 0 }",
      "  return step + count(value - 1, step)",
      "}",
      `function describeValue(value, prefix = "${prefix}") {`,
      "  return `${prefix}:${value}`",
      "}",
      `say describeValue(${call})`,
    ],
  );
}

function speakersSource(choices: SourceChoices): ValidSourceCase {
  const speaker = choices.pick(["vera", "mira", "noor"] as const);
  const displayName = choices.pick(["Vera", "Mira", "Noor"] as const);
  const defaultText = choices.pick(["default", "hello", "ready"] as const);
  const explicitText = choices.pick(["override", "again", "noted"] as const);
  return valid(
    "speakers-default-output-and-say-as",
    `speaker=${speaker} display=${displayName} text=${defaultText}/${explicitText}`,
    [
      `speaker ${speaker} { displayName: "${displayName}" }`,
      `speaker ${speaker}`,
      `say "${defaultText}"`,
      `say as ${speaker} "${explicitText}"`,
    ],
  );
}

function randomSource(choices: SourceChoices): ValidSourceCase {
  const lower = choices.integer(1, 3);
  const width = choices.integer(3, 5);
  const inclusive = choices.pick([true, false] as const);
  const chance = choices.pick([20, 50, 80] as const);
  const range = inclusive ? `${lower}..=${lower + width}` : `${lower}..${lower + width}`;
  return valid(
    "deterministic-random-builtins",
    `range=${range} chance=${chance}`,
    [
      `let roll = randomInteger(${range})`,
      `let lucky = chance(${chance})`,
      "say `${roll}:${lucky}:${random()}`",
    ],
  );
}

function missingIdentifierCase(
  choices: SourceChoices,
  family: "missing-declaration-identifier",
): NearValidSourceCase {
  const value = choices.integer(1, 9);
  return nearValid(family, `literal=${value}`, `let = ${value}`, "TSP013");
}

function missingTemplateExpressionCase(
  choices: SourceChoices,
  family: "template-interpolation",
): NearValidSourceCase {
  const text = choices.pick(["Hello", "Count", "Value"] as const);
  return nearValid(family, `text=${text}`, `say \`${text} \${}\``, "TSP008");
}

function outsideLoopCase(
  choices: SourceChoices,
  family: "loop-control",
): NearValidSourceCase {
  const keyword = choices.pick(["break", "continue"] as const);
  return nearValid(family, `outside-loop=${keyword}`, keyword, "TSV008");
}

function unknownNameCase(
  choices: SourceChoices,
  family: "semantic-name",
): NearValidSourceCase {
  const identifier = `unknownValue${choices.integer(1, 9)}`;
  return nearValid(family, `identifier=${identifier}`, `say ${identifier}`, "TSV002");
}

function duplicateParameterCase(
  choices: SourceChoices,
  family: "function-arguments",
): NearValidSourceCase {
  const identifier = `value${choices.integer(1, 9)}`;
  return nearValid(
    family,
    `duplicate-parameter=${identifier}`,
    `function sample(${identifier}, ${identifier}) { return ${identifier} }`,
    "TSV014",
  );
}

function compositeSetElementCase(
  choices: SourceChoices,
  family: "set-elements",
): NearValidSourceCase {
  const value = choices.integer(1, 9);
  return nearValid(family, `composite-list-value=${value}`, `let values = set[[${value}]]`, "TSV006");
}

function valid(
  family: ValidSourceCase["family"],
  variant: string,
  lines: readonly string[],
): ValidSourceCase {
  return { classification: "valid", family, variant, source: lines.join("\n") };
}

function nearValid(
  family: NearValidSourceCase["family"],
  variant: string,
  source: string,
  diagnosticCode: string,
): NearValidSourceCase {
  return {
    classification: "near-valid",
    family,
    variant,
    source,
    diagnosticCodes: [diagnosticCode],
  };
}

function countCall(
  callStyle: "default" | "positional" | "named",
  count: number,
  step: number,
): string {
  switch (callStyle) {
    case "default":
      return `value: count(${count})`;
    case "positional":
      return `value: count(${count}, ${step})`;
    case "named":
      return `value: count(value: ${count}, step: ${step})`;
  }
}

export function selectSourceFamily<T>(
  families: readonly T[],
  seed: number,
  index: number,
): T {
  return families[(seed + index) % families.length]!;
}

class SourceChoices {
  #state: number;

  public constructor(seed: number, index: number) {
    this.#state = mixSeed(seed, index);
  }

  public integer(minimum: number, maximum: number): number {
    return minimum + (this.next() % (maximum - minimum + 1));
  }

  public pick<T>(values: readonly T[]): T {
    return values[this.next() % values.length]!;
  }

  private next(): number {
    let state = this.#state;
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    this.#state = state >>> 0;
    return this.#state;
  }
}

function mixSeed(seed: number, index: number): number {
  const mixed = (seed ^ Math.imul(index + 1, 0x9e37_79b1)) >>> 0;
  return mixed === 0 ? 1 : mixed;
}
