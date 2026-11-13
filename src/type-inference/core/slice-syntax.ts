import type {
  Block,
  CallExpression,
  DurationLiteral,
  Expression,
  InteractionExpression,
  ObjectLiteral,
  Program,
  Statement,
  TransferTarget,
  TypeAnnotation,
} from "../../ast.js";
import { isButtonBackground, isChoiceObjectProperty } from "../../choice-rules.js";
import { CONVERSIONS, isConversion, type Conversion } from "../../conversions.js";
import { dictMethod } from "../../dict-operations.js";
import {
  durationLiteralValue,
  isStoredCalendarDurationRecord,
  isStoredDurationRecord,
} from "../../duration.js";
import { isBlankTextAnswer } from "../../interaction-answers.js";
import { listMethod } from "../../list-methods.js";
import { isTextMethod, TEXT_METHODS } from "../../text-operations.js";
import type { SourceSpan } from "../../source.js";
import {
  askParts,
  nestedStatements,
  sayOperands,
  showButtonOptions,
  statementExpressions,
  staticText,
} from "../../expression-children.js";
import { canonicalWebUrl } from "../../web-url.js";
import { SLICE_DEPTH } from "./contract-descriptors.js";
import type { ItemTag } from "./items.js";
import { VALUE_KIND_NAMES, VALUE_KINDS } from "../../value-kinds.js";
import { methodCategory } from "./method-categories.js";
import type { CoreFile } from "./program.js";

/*
 * The candidate slice's syntax (the port plan's S5, `backend.ts`'s module comment): whether a program is inside it is a
 * property of the slice, read by the candidate route before its analysis (`CORE_BACKEND`) and by the analysis's capture
 * of the stores' contracts (#1526 phase B, `Consumers`), so both decide alike from one walk. A pure walk of the syntax:
 * it reads no answer of the analysis.
 */

/** A construct outside the slice: where it stands and what it is. */
export interface Outside {
  readonly file: number;
  readonly span: SourceSpan;
  readonly what: string;
}

// ------------------------------------------------------------------------------------------------- the syntax

/** The types a written type nests: an optional's value, a collection's element, a union's members. */
function typeParts(type: TypeAnnotation): readonly TypeAnnotation[] {
  switch (type.kind) {
    case "namedType":
      return [];
    case "optionalType":
      return [type.value];
    case "listType":
    case "setType":
    case "dictType":
      return [type.element];
    case "unionType":
      return type.members;
  }
}

/**
 * A position of a written type whose only kind is `null`, or `null` where it has none: the type itself, or one inside
 * it, an optional's value, a collection's element, a union's member that is not `null` alone. A value read from such a
 * place is `null` to today's checker and `unknown` to the core where it enters from the host, so the slice takes no
 * such type, wherever it is written. (Walked, not recursed: a written type nests without bound.)
 */
function nullOnlyPosition(annotation: TypeAnnotation): TypeAnnotation | null {
  // (each type before the types it nests)
  const nested: TypeAnnotation[] = [];
  const unwalked = [annotation];
  for (let type = unwalked.pop(); type !== undefined; type = unwalked.pop()) {
    nested.push(type);
    for (const part of typeParts(type)) unwalked.push(part);
  }
  // whether a type's values can only be `null`: the name `null`, an optional or a union of such types (a collection is
  // a value of its own), each judged after the types it nests
  const onlyNull = new Map<TypeAnnotation, boolean>();
  for (const type of nested.reverse())
    onlyNull.set(
      type,
      type.kind === "namedType"
        ? type.name === "null"
        : type.kind === "optionalType"
          ? onlyNull.get(type.value) === true
          : type.kind === "unionType" &&
            type.members.every((member) => onlyNull.get(member) === true),
    );
  // the first such position, outermost first, in written order
  const pending = [annotation];
  for (let type = pending.pop(); type !== undefined; type = pending.pop()) {
    if (onlyNull.get(type) === true) return type;
    // (a union's member that is `null` alone is the union's `null`, beside its other members)
    const parts = typeParts(type).filter(
      (part) => type.kind !== "unionType" || onlyNull.get(part) !== true,
    );
    for (let part = parts.pop(); part !== undefined; part = parts.pop()) pending.push(part);
  }
  return null;
}

/** The written types of the slice: named types, `T?` and `T[]` of them, none with a position only `null` fills. */
function annotationOutside(annotation: TypeAnnotation): TypeAnnotation | null {
  const nullOnly = nullOnlyPosition(annotation);
  if (nullOnly !== null) return nullOnly;
  const pending: [TypeAnnotation, number][] = [[annotation, 0]];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [type, depth] = next;
    switch (type.kind) {
      case "namedType":
        break;
      case "optionalType":
        pending.push([type.value, depth]);
        break;
      case "listType":
        // a list at the facts' deepest depth (`SLICE_DEPTH`)
        if (depth + 1 >= SLICE_DEPTH) return type;
        pending.push([type.element, depth + 1]);
        break;
      default:
        return type;
    }
  }
  return null;
}

/** An AST kind: a row of the route's syntax table (`DISPOSITIONS`). */
export type SyntaxKind = Statement["kind"] | Expression["kind"];

type NodeOfKind<K extends SyntaxKind> = Extract<Statement | Expression, { readonly kind: K }>;

/** What the walk knows beside a node: its file's `let` names, the host values, and the keys loaded so far. */
interface SyntaxWalk {
  readonly lets: ReadonlySet<string>;
  readonly globals: ReadonlySet<string>;
  /** Each key loaded so far, once in the project: the agreement of a key's loads is S9b's (S3 §3). */
  readonly loaded: Set<string>;
}

/** A refusal a row places among its children, reached where it stands in source order: a part that is no expression. */
interface Refusal {
  readonly kind: "refusal";
  readonly span: SourceSpan;
  readonly what: string;
}

/** A child of a node the walk visits after it. */
type Child = Statement | Expression | Block | Refusal | null;

/** What a modelled row does at a node: the children walked after it, in source order, or its refusal there. */
type Visit =
  | { readonly walk: readonly Child[] }
  | { readonly refuse: { readonly span: SourceSpan; readonly what: string } };

/**
 * Where the runtime checks one operand of a `pass` row whatever the plan carries: the function of `file` that fails on a
 * value the operand does not take (`type-core-pass-rows.test.ts` reads that it raises a runtime fault; the row guard's
 * misfit runs show each operand's code).
 */
export interface OperandCheck {
  readonly file: string;
  readonly function: string;
}

/**
 * A row of the table: `refused`, a construct outside the slice, refused at its span as `this <kind in words>`;
 * `modelled`, a construct of the slice, with the conditions under which it is, which its `visit` checks; or `pass`, a
 * command the analysis needs nothing of beyond its operands (#2488's design, the `pass` rule): it stores into no place
 * of the script, registers no handler and moves no control, so the flow graph builds only its operands and its
 * fall-through, and each of its operands, by name, is checked by its instruction (`operands`).
 */
type Disposition<K extends SyntaxKind> =
  | { readonly row: "refused" }
  | { readonly row: "modelled"; readonly visit: (node: NodeOfKind<K>, walk: SyntaxWalk) => Visit }
  | {
      readonly row: "pass";
      readonly operands: Readonly<Record<string, OperandCheck>>;
      readonly visit: (node: NodeOfKind<K>, walk: SyntaxWalk) => Visit;
    };

const REFUSED = { row: "refused" } as const;
/** The children to walk, as one list: never spread into arguments, whose count is bounded below a source's width. */
const walk = (children: readonly Child[]): Visit => ({ walk: children });
const refuse = (span: SourceSpan, what: string): Visit => ({ refuse: { span, what } });
/** A construct of the slice under no condition of its own, with these children. */
const modelled = <K extends SyntaxKind>(
  children: (node: NodeOfKind<K>) => (Statement | Expression | Block | null)[] = () => [],
): Disposition<K> => ({ row: "modelled", visit: (node) => walk(children(node)) });

/** A `pass` row whose children are its statement's own expressions (`statementExpressions`, in source order). */
const pass = <K extends Statement["kind"]>(
  operands: Readonly<Record<string, OperandCheck>>,
): Disposition<K> => ({
  row: "pass",
  operands,
  visit: (node) => {
    // EVIDENCE: invariant: `K` is a statement kind, so the node of its row is a statement.
    const statement = node as Statement;
    return walk([...statementExpressions(statement)]);
  },
});

const MEDIA = "src/runtime/instructions/media.ts";
const INTERACTION = "src/runtime/instructions/interaction.ts";
const TIMERS = "src/runtime/instructions/timers.ts";
/** Shown text: `fieldText` takes a value that shows as text and refuses any other. */
const SHOWN_TEXT: OperandCheck = {
  file: "src/runtime/values/value-text.ts",
  function: "fieldText",
};
const UI_CHECK: OperandCheck = { file: INTERACTION, function: "materializeInteractionUi" };

/**
 * A command or request operand's rule (#2488's command operand table, step 1½): `takes`, the kinds the route admits
 * there, as today's checker does, of which the instruction may still refuse a value as it runs; `form`, a rule on the
 * operand as written (a known text, a choice object written in place); `today`, today's compile errors for a value the
 * route does not admit; `check`, where the instruction refuses a value it does not take whatever the plan says.
 */
export interface OperandRule {
  readonly takes: readonly ItemTag[];
  readonly form?: (operand: Expression) => boolean;
  readonly today: readonly string[];
  readonly check: OperandCheck;
}

/** The kinds that show as text. */
const SHOWS: readonly ItemTag[] = VALUE_KIND_NAMES.filter(
  (kind) => VALUE_KINDS[kind].shown !== null,
);
const shown = (check: OperandCheck): OperandRule => ({
  takes: SHOWS,
  today: ["TSV040", "TSV042"],
  check,
});

/** The kinds a choice's button may return (V30 §19). */
const CHOICE_VALUES: readonly ItemTag[] = VALUE_KIND_NAMES.filter(
  (kind) => VALUE_KINDS[kind].choice,
);
const CHOICE_CHECK: OperandCheck = {
  file: "src/runtime/actions/choice-options.ts",
  function: "expandChoiceOptions",
};
/**
 * A choice's rule; `button`, an operand that gives a button itself, whose choice object written in place needs its
 * shape.
 */
const choice = (takes: readonly ItemTag[], button: "returns" | "labelled" | null): OperandRule => ({
  takes,
  ...(button === null ? {} : { form: choiceObjectShape(button === "returns") }),
  today: ["TSV029", "TSV040", "TSV042"],
  check: CHOICE_CHECK,
});
const choiceObjectShape =
  (returns: boolean) =>
  (operand: Expression): boolean => {
    const written = unwrapped(operand);
    return (
      written.kind !== "objectLiteral" ||
      (written.properties.some((property) => property.name.name === "text") &&
        written.properties.every(
          (property) =>
            isChoiceObjectProperty(property.name.name) &&
            (returns || property.name.name !== "value"),
        ))
    );
  };
/** A rule on a known text, true where the text is not known. */
const knownText =
  (rule: (text: string) => boolean) =>
  (operand: Expression): boolean => {
    const text = staticText(operand);
    return text === undefined || rule(text);
  };

/** The command operand table, by row and position; an ask's positions read as `askText.question`. */
export const COMMAND_OPERANDS = {
  showImageStatement: {
    image: {
      takes: ["string", "null"],
      today: ["TSV036"],
      check: { file: MEDIA, function: "showImage" },
    },
  },
  openUrlStatement: {
    url: {
      takes: ["string"],
      form: knownText((text) => canonicalWebUrl(text) !== null),
      today: ["TSV043"],
      check: UI_CHECK,
    },
    buttonText: shown(SHOWN_TEXT),
    alwaysButton: { takes: ["boolean"], today: ["TSV043"], check: UI_CHECK },
  },
  exportTextStatement: {
    text: { takes: ["string"], today: ["TSV043"], check: UI_CHECK },
    title: shown(SHOWN_TEXT),
    fileName: { takes: ["string"], today: ["TSV043"], check: UI_CHECK },
  },
  showPopupStatement: { message: shown(SHOWN_TEXT), buttonText: shown(SHOWN_TEXT) },
  waitStatement: {
    // (a duration without a unit after it; with one, `wait n s`, an amount of that unit, or a range of them)
    duration: {
      takes: ["duration"],
      today: ["TSV043"],
      check: { file: TIMERS, function: "timerDurationMs" },
    },
    amount: {
      takes: ["integer", "number", "range"],
      today: ["TSV043"],
      check: { file: TIMERS, function: "timerDurationMs" },
    },
  },
  deleteStatement: {
    key: {
      takes: ["string"],
      today: ["TSV038"],
      check: { file: "src/runtime/host-data/script-storage.ts", function: "storageKey" },
    },
  },
  showButtonStatement: {
    label: shown(SHOWN_TEXT),
    background: {
      takes: ["string", "null"],
      form: knownText(isButtonBackground),
      today: ["TSV029"],
      check: UI_CHECK,
    },
    timeout: {
      takes: ["duration"],
      today: ["TSV043"],
      check: { file: INTERACTION, function: "buttonTimeoutMs" },
    },
  },
  sayStatement: {
    pacing: {
      takes: ["duration"],
      today: ["TSV043"],
      check: { file: "src/runtime/instructions/say.ts", function: "sayDurationMs" },
    },
  },
  gotoStatement: {
    path: {
      takes: ["string"],
      today: ["TSV043"],
      check: { file: "src/runtime/evaluator.ts", function: "scriptReference" },
    },
  },
  interactionExpression: {
    // (a prefill is no position)
    ...Object.fromEntries(
      (
        [
          "askText",
          "askNumber",
          "askInteger",
          "askDate",
          "askTime",
          "askDateTime",
          "askPassword",
          "askBoolean",
        ] as const
      ).flatMap((ask) => [
        [`${ask}.question`, shown(SHOWN_TEXT)],
        ...(ask === "askBoolean"
          ? [
              [`${ask}.yesText`, shown(SHOWN_TEXT)],
              [`${ask}.noText`, shown(SHOWN_TEXT)],
            ]
          : [[`${ask}.hint`, shown(SHOWN_TEXT)]]),
      ]),
    ),
    // (an `askChoice`'s buttons, V30 §19)
    "askChoice.option": choice([...CHOICE_VALUES, "object", "list", "set"], "returns"),
    "askChoice.element": choice([...CHOICE_VALUES, "object"], "returns"),
    "askChoice.label": choice([...SHOWS, "object", "list", "set"], "labelled"),
    "askChoice.labelledElement": choice([...SHOWS, "object"], "labelled"),
    // (a choice object written in place: its text, shown, and also returned where it has no `value` and no label; its
    // value)
    "askChoice.text": choice(SHOWS, null),
    "askChoice.returnedText": choice(CHOICE_VALUES, null),
    "askChoice.value": choice(CHOICE_VALUES, null),
    "askChoice.background": {
      takes: ["string", "null"],
      form: knownText(isButtonBackground),
      today: ["TSV029"],
      check: CHOICE_CHECK,
    },
  },
} satisfies Readonly<Record<string, Readonly<Record<string, OperandRule>>>>;

/** The table's rows by AST kind. */
const OPERAND_RULES: Readonly<Record<string, Readonly<Record<string, OperandRule>>>> =
  COMMAND_OPERANDS;

/** A row's operand rules (`COMMAND_OPERANDS`), or `undefined` for a kind the table has no row for. */
export function operandRules(kind: string): Readonly<Record<string, OperandRule>> | undefined {
  return Object.hasOwn(OPERAND_RULES, kind) ? OPERAND_RULES[kind] : undefined;
}

/** An ask's name as a script writes it: `askText`, `askDateTime`. */
const ASK_NAMES: Readonly<Record<InteractionExpression["interactionKind"], string>> = {
  text: "askText",
  number: "askNumber",
  integer: "askInteger",
  date: "askDate",
  time: "askTime",
  datetime: "askDateTime",
  password: "askPassword",
  boolean: "askBoolean",
  choice: "askChoice",
  form: "askForm",
  booleans: "askBooleans",
};

/**
 * A command's or an ask's operands by the table's positions (`COMMAND_OPERANDS`), in source order; an operand the table
 * names no position for is not listed.
 */
export function commandOperands(
  node: Statement | InteractionExpression,
): readonly (readonly [string, Expression])[] {
  switch (node.kind) {
    case "showImageStatement":
      return [["image", node.image]];
    case "waitStatement":
      return [[node.unit === null ? "duration" : "amount", node.duration]];
    case "deleteStatement":
      return [["key", node.key]];
    case "showPopupStatement":
    case "openUrlStatement":
    case "exportTextStatement": {
      const first =
        node.kind === "showPopupStatement"
          ? "message"
          : node.kind === "openUrlStatement"
            ? "url"
            : "text";
      return node.arguments.map((argument) => [
        argument.kind === "namedArgument" ? argument.name.name : first,
        argument.value,
      ]);
    }
    case "showButtonStatement":
      return [
        ["label", node.label],
        ...showButtonOptions(node).map((option) => [option.name, option.value] as const),
      ];
    case "sayStatement":
      return node.pacing === null || node.pacing === "instant" ? [] : [["pacing", node.pacing]];
    case "gotoStatement": {
      const path = transferPath(node.target);
      return path === null || path === undefined ? [] : [["path", path]];
    }
    case "interactionExpression":
      return askOperandsByPosition(node);
    default:
      return [];
  }
}

/**
 * A choice object written in place, by its properties' positions: its text, returned where it has no `value` and the
 * button does not return the value written before `:` (`labelled`).
 */
function choiceObject(object: ObjectLiteral, labelled: boolean): (readonly [string, Expression])[] {
  const returned =
    !labelled && !object.properties.some((property) => property.name.name === "value");
  return object.properties.flatMap((property): (readonly [string, Expression])[] =>
    property.name.name === "text"
      ? [[returned ? "askChoice.returnedText" : "askChoice.text", property.value]]
      : property.name.name === "value" || property.name.name === "background"
        ? [[`askChoice.${property.name.name}`, property.value]]
        : [],
  );
}

/** An ask's operands by the table's positions (`commandOperands`). */
function askOperandsByPosition(ask: InteractionExpression): (readonly [string, Expression])[] {
  const name = ASK_NAMES[ask.interactionKind];
  const named = (argument: string) =>
    ask.formArguments.find((given) => given.name.name === argument)?.value ?? null;
  const at = (position: string, operand: Expression | null) =>
    operand === null ? [] : [[`${name}.${position}`, operand] as const];
  if (ask.interactionKind === "choice")
    return ask.options.flatMap((option): (readonly [string, Expression])[] => {
      const value = unwrapped(option.expression);
      if (option.value !== null)
        return [
          [`${name}.label`, option.expression],
          ...(value.kind === "objectLiteral" ? choiceObject(value, true) : []),
          ...(value.kind === "listLiteral"
            ? value.elements.flatMap((element): (readonly [string, Expression])[] => {
                const written = unwrapped(element);
                return [
                  [`${name}.labelledElement`, element],
                  ...(written.kind === "objectLiteral" ? choiceObject(written, true) : []),
                ];
              })
            : []),
        ];
      if (value.kind === "listLiteral")
        return value.elements.flatMap((element): (readonly [string, Expression])[] => {
          const written = unwrapped(element);
          return [
            [`${name}.element`, element],
            ...(written.kind === "objectLiteral" ? choiceObject(written, false) : []),
          ];
        });
      if (value.kind === "objectLiteral")
        return [[`${name}.option`, option.expression], ...choiceObject(value, false)];
      return [[`${name}.option`, option.expression]];
    });
  return [
    ...at("question", ask.question ?? named("message")),
    ...at("hint", ask.hint),
    ...at("yesText", named("yesText")),
    ...at("noText", named("noText")),
  ].sort((a, b) => a[1].span.start.offset - b[1].span.start.offset);
}

/** The citations of a `pass` row's operands, read from the table. */
const checksOf = (row: keyof typeof COMMAND_OPERANDS): Readonly<Record<string, OperandCheck>> =>
  Object.fromEntries(
    Object.entries(operandRules(row) ?? {}).map(([name, rule]) => [name, rule.check]),
  );

/**
 * The route's syntax table: a row for every AST kind (a kind without one, or a row for no kind, fails the build), so a
 * new construct is refused by its row, never by a default, and opening one is a change of its row.
 */
export const DISPOSITIONS: { readonly [K in SyntaxKind]: Disposition<K> } = {
  // ------------------------------------------------------------------------------------------- statements
  // (a speaker is set up at the start of the session, storing its values into its own places, so not `pass`; each value
  // is judged by its own row, so a speaker's name in one is refused there, and the core judges its built-in fields'
  // values after the analysis, `backend.ts`'s `outsideAnswers`)
  speakerDeclaration: modelled((node) => node.properties.map((property) => property.value)),
  speakerSetterStatement: pass({}),
  sayStatement: {
    row: "modelled",
    // (a `say as` names its speaker by an identifier that is no expression, so it is not walked; its presentation, text
    // and pacing are walked in evaluation order, `sayOperands`)
    visit: (node) =>
      node.value.kind === "stringLiteral" &&
      node.value.parts.some((part) => part.kind !== "stringText")
        ? refuse(node.span, "this say")
        : walk([...sayOperands(node)]),
  },
  // (`showButton as` names its speaker as `say as` does, not walked)
  showButtonStatement: pass(checksOf("showButtonStatement")),
  waitStatement: pass(checksOf("waitStatement")),
  timerStatement: REFUSED,
  showImageStatement: pass(checksOf("showImageStatement")),
  hideImageStatement: pass({}),
  showCameraStatement: REFUSED,
  hideCameraStatement: REFUSED,
  showPopupStatement: pass(checksOf("showPopupStatement")),
  openUrlStatement: pass(checksOf("openUrlStatement")),
  exportTextStatement: pass(checksOf("exportTextStatement")),
  showPermanentButtonStatement: REFUSED,
  playMediaStatement: REFUSED,
  stopAudioStatement: pass({}),
  saveStatement: REFUSED,
  deleteStatement: pass(checksOf("deleteStatement")),
  exitStatement: modelled(),
  endStatement: REFUSED,
  labelStatement: REFUSED,
  gotoStatement: {
    row: "modelled",
    // (a file from its top, through its path, `transferPath`: the path is walked and not a `script(…)` call holding it,
    // so no script value opens elsewhere)
    visit: (node) => {
      const path = transferPath(node.target);
      return path === undefined ? refuse(node.span, "this goto statement") : walk([path]);
    },
  },
  callFileStatement: REFUSED,
  letStatement: {
    row: "modelled",
    visit: (node) => {
      const written = node.typeAnnotation === null ? null : annotationOutside(node.typeAnnotation);
      return written !== null
        ? refuse(written.span, "this written type")
        : walk([node.initializer]);
    },
  },
  globalStatement: REFUSED,
  assignmentStatement: {
    row: "modelled",
    visit: (node) =>
      node.operator !== "="
        ? refuse(node.span, "this assignment")
        : node.target.kind === "identifier"
          ? walk([node.target, node.value])
          : node.target.kind === "propertyAccessExpression"
            ? walk([node.target.object, node.value])
            : refuse(node.span, "this assignment"),
  },
  ifStatement: modelled((node) => [node.condition, node.thenBlock, node.elseBlock]),
  switchStatement: {
    row: "modelled",
    // (its subject, then each case's values or type test and its body, then the default, in source order; a type test's
    // written type judged as a `let`'s, refused where it stands; a case that can never match is refused after the
    // analysis, `backend.ts`)
    visit: (node) =>
      walk([
        node.subject,
        ...node.cases.flatMap((switchCase): Child[] => {
          const written =
            switchCase.typeTest === null ? null : annotationOutside(switchCase.typeTest.type);
          return [
            ...switchCase.values,
            written !== null
              ? { kind: "refusal", span: written.span, what: "this written type" }
              : null,
            switchCase.body,
          ];
        }),
        node.defaultBlock,
      ]),
  },
  repeatStatement: modelled((node) => [node.count, node.body]),
  forStatement: modelled((node) => [node.iterable, node.body]),
  whileStatement: modelled((node) => [node.condition, node.body]),
  breakStatement: modelled(),
  continueStatement: modelled(),
  functionDeclaration: REFUSED,
  returnStatement: REFUSED,
  expressionStatement: {
    row: "modelled",
    // (a call for what it does, such as `xs.sort()`)
    visit: (node) =>
      node.expression.kind === "callExpression"
        ? walk([node.expression])
        : refuse(node.span, "this expression statement"),
  },
  // ------------------------------------------------------------------------------------------- expressions
  identifier: {
    row: "modelled",
    visit: (node, { lets, globals }) =>
      lets.has(node.name) || globals.has(node.name)
        ? walk([])
        : refuse(node.span, `the name '${node.name}'`),
  },
  booleanLiteral: modelled(),
  nullLiteral: modelled(),
  numberLiteral: modelled(),
  durationLiteral: {
    row: "modelled",
    visit: (node) => (storedLiteral(node) ? walk([]) : refuse(node.span, "this duration literal")),
  },
  unitExpression: modelled((node) => [node.operand]),
  angleExpression: modelled((node) => [node.operand]),
  stringLiteral: {
    row: "modelled",
    visit: (node) =>
      node.parts.some((part) => part.kind !== "stringText")
        ? refuse(node.span, "text with interpolation")
        : walk([]),
  },
  regexLiteral: modelled(),
  listLiteral: modelled((node) => [...node.elements]),
  objectLiteral: modelled((node) => node.properties.map((property) => property.value)),
  setLiteral: REFUSED,
  dictLiteral: REFUSED,
  parenthesizedExpression: modelled((node) => [node.expression]),
  propertyAccessExpression: {
    row: "modelled",
    // (a member of a literal that is no object, written as the receiver: its members are S9b's, as the route refuses any
    // receiver that may be no object after the analysis, `outsideAnswers`)
    visit: (node) =>
      NOT_OBJECT_LITERALS.has(unwrapped(node.object).kind)
        ? refuse(node.span, "this member or element read")
        : walk([node.object]),
  },
  indexExpression: modelled((node) => [node.object, node.index]),
  callExpression: {
    row: "modelled",
    visit: (node) =>
      sliceCall(node) === null
        ? refuse(node.span, "this call expression")
        : walk([
            ...(node.callee.kind === "propertyAccessExpression" ? [node.callee.object] : []),
            ...node.arguments.map((argument) => argument.value),
          ]),
  },
  unaryExpression: REFUSED,
  binaryExpression: {
    row: "modelled",
    // (`otherwise`, and the narrowing's own null tests, `x != null` and `x == null`, §13.2's G: every other operator is
    // S9b's, by its own rule)
    visit: (node) =>
      node.operator !== "otherwise" && !nullTest(node)
        ? refuse(node.span, "this binary expression")
        : walk([node.left, node.right]),
  },
  rangeExpression: modelled((node) => [node.start, node.end]),
  interactionExpression: {
    row: "modelled",
    // (the asks of `SLICE_ASKS`, with a prefill `askPrefillAdmitted` admits; its parts in evaluation order, `askParts`:
    // options, presentation, question, `hint:` and `prefill:` as written, or the named arguments; `as` names its speaker
    // by an identifier that is no expression, not walked)
    visit: (node) =>
      !SLICE_ASKS.has(node.interactionKind) || !askPrefillAdmitted(node)
        ? refuse(node.span, "this ask")
        : walk([...askParts(node)]),
  },
  sayExpression: REFUSED,
  showButtonExpression: REFUSED,
  showPopupExpression: REFUSED,
  timerExpression: REFUSED,
  playMediaExpression: REFUSED,
  showCameraExpression: REFUSED,
  showPermanentButtonExpression: REFUSED,
  loadExpression: {
    row: "modelled",
    visit: (node, { loaded }) => {
      const key = unwrapped(node.key);
      // the key as the session names it, whatever its spelling
      const name =
        key.kind === "stringLiteral" && key.parts.every((part) => part.kind === "stringText")
          ? key.parts.map((part) => (part.kind === "stringText" ? part.value : "")).join("")
          : null;
      // (a computed key is external data, F19: no other load's key; a default written as `null` is only null, which the
      // route refuses after the analysis wherever it finds one, `outsideAnswers`: without a declared type, the storage
      // rules' error, S9b's)
      if (
        node.defaultValue === null ||
        (name !== null && loaded.has(name)) ||
        unwrapped(node.defaultValue).kind === "nullLiteral"
      )
        return refuse(node.span, "this load expression");
      if (name !== null) loaded.add(name);
      return walk([node.key, node.defaultValue]);
    },
  },
  tagQueryExpression: REFUSED,
  typeTestExpression: {
    row: "modelled",
    // (`x is T` and `x is not T`, the narrowing's type test, its type a written type of the slice)
    visit: (node) => {
      const written = annotationOutside(node.type);
      return written !== null ? refuse(written.span, "this written type") : walk([node.value]);
    },
  },
};

/**
 * The first construct of the files outside the slice's syntax, in source order: a statement, an expression, a written
 * type, or a name that is neither one of its file's variables nor a host value (a built-in, a speaker). Each node is
 * judged by its row of `DISPOSITIONS`, then its children, so an open construct holding a closed one is refused at the
 * closed one.
 */
export function outsideSyntax(
  files: readonly CoreFile[],
  globals: ReadonlySet<string>,
): Outside | null {
  const loaded = new Set<string>();
  for (const [file, { program }] of files.entries()) {
    const context: SyntaxWalk = { lets: letNames(program), globals, loaded };
    const pending: (Statement | Expression | Refusal)[] = [...program.statements].reverse();
    for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
      if (node.kind === "refusal") return { file, span: node.span, what: node.what };
      // EVIDENCE: invariant: a node's row is the row of its own kind, so its `visit` takes that node.
      const row = DISPOSITIONS[node.kind] as Disposition<SyntaxKind>;
      if (row.row === "refused")
        return { file, span: node.span, what: `this ${describe(node.kind)}` };
      const visit = row.visit(node, context);
      if ("refuse" in visit) return { file, ...visit.refuse };
      // children are pushed last to first, so they are visited in source order
      for (let position = visit.walk.length - 1; position >= 0; position -= 1) {
        const child = visit.walk[position];
        if (child === null || child === undefined) continue;
        if (child.kind === "block")
          for (let at = child.statements.length - 1; at >= 0; at -= 1)
            pending.push(child.statements[at]!);
        else pending.push(child);
      }
    }
  }
  return null;
}

/** Whether the plan can store a duration literal's value (ADR 0026). */
function storedLiteral(node: DurationLiteral): boolean {
  const value = durationLiteralValue(node);
  if (typeof value === "string") return false;
  return value.kind === "duration"
    ? isStoredDurationRecord({ ...value })
    : isStoredCalendarDurationRecord({ ...value });
}

/** Whether a comparison is a null test, `x != null` or `x == null` (either side the `null`). */
function nullTest(node: Extract<Expression, { kind: "binaryExpression" }>): boolean {
  return (
    (node.operator === "!=" || node.operator === "==") &&
    (unwrapped(node.left).kind === "nullLiteral" || unwrapped(node.right).kind === "nullLiteral")
  );
}

/** The slice's literals that are no object (`outsideSyntax`'s literal cases). */
const NOT_OBJECT_LITERALS: ReadonlySet<Expression["kind"]> = new Set([
  "numberLiteral",
  "booleanLiteral",
  "nullLiteral",
  "regexLiteral",
  "stringLiteral",
  "listLiteral",
]);

function unwrapped(expression: Expression): Expression {
  let current = expression;
  while (current.kind === "parenthesizedExpression") current = current.expression;
  return current;
}

/** The calls of the slice, by what each is (see the module's comment); `null` for any other call. */
type SliceCall =
  "get" | "conversion" | "fromJson" | "fileFromBase64" | "decrypt" | "method" | "toJson";

/**
 * A method of text, a list, a set or a dict that changes nothing in its receiver, and a list's `sort`, called with as
 * many positional arguments as one of its contracts takes and no named one: the methods whose arguments and elements C13
 * checks (`signatures.ts`); a call's shape is the argument rules' (TSV020, S9b). A method that adds to its receiver
 * stores its argument, whose check has no place in the plan yet; one that removes, reorders or copies the receiver's
 * elements is the slice's when the runs the route's tests derive follow it.
 */
function sliceMethod(call: CallExpression): boolean {
  if (call.callee.kind !== "propertyAccessExpression") return false;
  const name = call.callee.property.name;
  if (call.arguments.some((argument) => argument.kind === "namedArgument")) return false;
  const list = listMethod(name);
  const dict = dictMethod(name);
  if ((list?.changes !== undefined && name !== "sort") || dict?.changes !== undefined) return false;
  // (a copy of the receiver's elements carries them, F10, which the runs the route's tests derive do not follow yet)
  if (methodCategory(name)?.gives.kind === "copy") return false;
  const parameters = [
    isTextMethod(name) ? TEXT_METHODS[name].parameters : null,
    list === undefined || list.named !== undefined ? null : list.parameters,
    dict === undefined || dict.named !== undefined ? null : dict.parameters,
  ];
  return parameters.some(
    (taken) =>
      taken !== null &&
      call.arguments.length <= taken.length &&
      call.arguments.length >=
        taken.filter((parameter) => !("optional" in parameter && parameter.optional === true))
          .length,
  );
}

/**
 * A call of the slice: a list's `get` with an index and its `default:`; a conversion of a value with its `default:`;
 * `fromJson` with its text, `default:` and maybe `files: false`; `fileFromBase64` with its text and `default:`;
 * `decryptText` or `decryptFile` with its value, `default:` and `password:` or `key:`. Any other is `null`.
 */
export function sliceCall(call: CallExpression): SliceCall | null {
  const positional = call.arguments.filter((argument) => argument.kind === "positionalArgument");
  const named = new Map(
    call.arguments.flatMap((argument) =>
      argument.kind === "namedArgument" ? [[argument.name.name, argument.value] as const] : [],
    ),
  );
  if (call.callee.kind === "propertyAccessExpression" && call.callee.property.name !== "get")
    return sliceMethod(call) ? "method" : null;
  // `toJson` of a value, whose files the slice writes as their text (C13: what it writes, `signatures.ts`)
  if (call.callee.kind === "identifier" && call.callee.name === "toJson")
    return positional.length === 1 && named.size === 0 ? "toJson" : null;
  if (positional.length !== 1 || !named.has("default")) return null;
  const others = [...named.keys()].filter((name) => name !== "default");
  if (call.callee.kind === "propertyAccessExpression") return others.length === 0 ? "get" : null;
  if (call.callee.kind !== "identifier") return null;
  const name = call.callee.name;
  if (name === "fromJson") {
    const files = named.get("files");
    return others.every((other) => other === "files") &&
      (files === undefined || (files.kind === "booleanLiteral" && !files.value))
      ? "fromJson"
      : null;
  }
  if (name === "fileFromBase64") return others.length === 0 ? "fileFromBase64" : null;
  if (name === "decryptText" || name === "decryptFile")
    return others.length === 1 && (others[0] === "password" || others[0] === "key")
      ? "decrypt"
      : null;
  if (!isConversion(name)) return null;
  const conversion: Conversion = CONVERSIONS[name];
  return conversion.takes === "value" && conversion.kinds !== "shown" && others.length === 0
    ? "conversion"
    : null;
}

/**
 * The path of a transfer to a file the slice holds: `null` for a quoted path, which holds no expression; the argument of
 * a `script(…)` call written as `transferCall` takes it; `undefined` for any other target (a label, a grouped or tagged
 * target, another shape of `script(…)`), which the slice does not hold.
 */
function transferPath(target: TransferTarget): Expression | null | undefined {
  if (target.kind === "fileTarget") return null;
  if (target.kind !== "scriptTarget") return undefined;
  const call = target.expression;
  return call.kind === "callExpression" && transferCall(call)
    ? call.arguments[0]!.value
    : undefined;
}

/**
 * `script(path)` with one positional argument: the one call outside `sliceCall` the slice holds, and only as a transfer's
 * target (`transferPath`), the `script` call in any other place being refused by the `callExpression` row.
 */
export function transferCall(call: CallExpression): boolean {
  return (
    call.callee.kind === "identifier" &&
    call.callee.name === "script" &&
    call.arguments.length === 1 &&
    call.arguments[0]!.kind === "positionalArgument"
  );
}

/**
 * The asks of the slice, those whose answer the core gives a kind (`interactionCategory`): not `askForm` and
 * `askBooleans`, the form of toggles built on it, whose answer it does not (V30 §20).
 */
const SLICE_ASKS: ReadonlySet<InteractionExpression["interactionKind"]> = new Set([
  "text",
  "number",
  "integer",
  "date",
  "time",
  "datetime",
  "password",
  "boolean",
  "choice",
]);

/** An ask's `prefill:`, a basic ask's or a choice's own, or `askBoolean`'s named argument. */
function askPrefill(ask: InteractionExpression): Expression | null {
  return (
    ask.prefill ??
    ask.formArguments.find((argument) => argument.name.name === "prefill")?.value ??
    null
  );
}

/**
 * The prefills of an ask the slice holds (V30 §19, §20): none, or a scalar literal the request takes as written: on
 * `askText` plain text that is not blank, on `askNumber` a number, on `askInteger` a whole number written as one in the
 * safe range, on `askBoolean` `true` or `false`, on `askChoice` any (a value no button has preselects none). Any other
 * literal is outside: today's checker refuses each (TSV039, and TSV043 on `askPassword`, which takes none), and a
 * literal of the request's own kind would be written into the plan's request, whose validation refuses it. A computed
 * prefill is outside too: the runtime takes `null` and blank text as none, and the core's kinds of a computed value do
 * not show every one that today's checker knows to be only `null` (a typed host value narrowed by a type test, or
 * stored under a branch).
 */
function askPrefillAdmitted(ask: InteractionExpression): boolean {
  const written = askPrefill(ask);
  if (written === null) return true;
  if (ask.interactionKind === "password") return false;
  const prefill = unwrapped(written);
  switch (prefill.kind) {
    case "stringLiteral":
      return (
        ask.interactionKind === "choice" ||
        (ask.interactionKind === "text" &&
          !isBlankTextAnswer(
            prefill.parts.map((part) => (part.kind === "stringText" ? part.value : "")).join(""),
          ))
      );
    case "numberLiteral":
      return (
        ask.interactionKind === "choice" ||
        ask.interactionKind === "number" ||
        (ask.interactionKind === "integer" &&
          prefill.numericType === "integer" &&
          Number.isSafeInteger(prefill.value))
      );
    case "booleanLiteral":
      return ask.interactionKind === "choice" || ask.interactionKind === "boolean";
    case "nullLiteral":
      return ask.interactionKind === "choice";
    default:
      return false;
  }
}

/** A node kind in words: `ifStatement` is "if statement". */
function describe(kind: string): string {
  return kind.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
}

/**
 * The names a file's `let` statements and `for` loops declare, at any depth of the blocks that run as part of a
 * statement (`nestedStatements`: branches, loop bodies, cases).
 */
function letNames(program: Program): Set<string> {
  const names = new Set<string>();
  const pending: Statement[] = [...program.statements];
  for (let statement = pending.pop(); statement !== undefined; statement = pending.pop()) {
    if (statement.kind === "letStatement") names.add(statement.name.name);
    else if (statement.kind === "forStatement") {
      names.add(statement.variable.name);
      if (statement.valueVariable !== null) names.add(statement.valueVariable.name);
    }
    for (const nested of nestedStatements(statement)) pending.push(nested);
  }
  return names;
}
