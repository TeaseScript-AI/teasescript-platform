import type { SyntaxKind } from "../../../src/type-inference/core/slice-syntax.js";

/*
 * The asks' part of the row guard's tables (`row-templates.ts`): their operand templates, the prefills and buttons the
 * route refuses, and their request positions with a declared rule difference.
 */

/** The basic asks with a `prefill:` (`askPassword` takes none), by the name an ask's position starts with. */
export const PREFILLED_ASKS = [
  "askText",
  "askNumber",
  "askInteger",
  "askDate",
  "askTime",
  "askDateTime",
];

/**
 * The operand positions of the asks (`askParts`), by ask and operand, each a `let` of the answer with the host global
 * there. An `askChoice`'s option stands alone, so the buttons' kinds are the sample's (two kinds are refused as a mixed
 * choice, `outsideAnswers`).
 */
export const ASK_OPERANDS: Readonly<Record<string, readonly string[]>> = {
  ...Object.fromEntries(
    [...PREFILLED_ASKS, "askPassword"].flatMap((ask) => [
      [`${ask}.question`, [`let r = ${ask}(hostValue)`]],
      [`${ask}.hint`, [`let r = ${ask}("q", hint: hostValue)`]],
      ...(ask === "askPassword"
        ? []
        : [[`${ask}.prefill`, [`let r = ${ask}("q", prefill: hostValue)`]]]),
    ]),
  ),
  "askText.presentation": ['let r = askText bubble(color: hostValue) "q"'],
  "askBoolean.question": [
    "let r = askBoolean(hostValue)",
    "let r = askBoolean(message: hostValue)",
  ],
  "askBoolean.yesText": ['let r = askBoolean("q", yesText: hostValue)'],
  "askBoolean.noText": ['let r = askBoolean("q", noText: hostValue)'],
  "askBoolean.prefill": ['let r = askBoolean("q", prefill: hostValue)'],
  "askBoolean.presentation": ['let r = askBoolean prose(align: hostValue) "q"'],
  "askChoice.option": ["let r = askChoice hostValue"],
  "askChoice.element": ["let r = askChoice [hostValue]"],
  "askChoice.label": ["let r = askChoice a: hostValue"],
  "askChoice.background": ['let r = askChoice {text: "t", background: hostValue}'],
  "askChoice.prefill": ["let r = askChoice 1, 2, prefill: hostValue"],
};

/** The literals the slice writes in place that are scalars: the ones a prefill written as a literal is read as. */
export const SCALAR_LITERALS: readonly string[] = [
  "integer",
  "number",
  "string",
  "boolean",
  "null",
];

/**
 * The kinds of the scalar literals each prefill takes as written (V30 §20; `askPrefillAdmitted` in
 * `src/type-inference/core/slice-syntax.ts` admits these and refuses the others): stated here apart from it.
 */
export const PREFILL_LITERALS: Readonly<Record<string, readonly string[]>> = {
  "askText.prefill": ["string"],
  "askNumber.prefill": ["integer", "number"],
  "askInteger.prefill": ["integer"],
  "askDate.prefill": [],
  "askTime.prefill": [],
  "askDateTime.prefill": [],
  "askBoolean.prefill": ["boolean"],
};

/**
 * The samples of an `askChoice`'s option and element positions the route refuses, by origin and kind: the core's check
 * of what the buttons return (TSV029, V30 §19, `choiceValues` in `src/type-inference/core/checks/interactions.ts`) has
 * something to say of them, a value no button returns or an object whose fields are unknown, and the route refuses
 * any of its diagnostics after the analysis ("this operand"). Measured on the samples; the guard keeps the list closed.
 */
export const CHOICE_REFUSED: Readonly<Record<string, readonly string[]>> = {
  "askChoice.option": [
    "literal range",
    "literal regex",
    "ingress dict",
    "ingress object",
    "ingress range",
    "ingress regex",
    "ingress script",
  ],
  "askChoice.element": [
    "literal list",
    "literal range",
    "literal regex",
    "ingress dict",
    "ingress list",
    "ingress object",
    "ingress range",
    "ingress regex",
    "ingress script",
    "ingress set",
  ],
};

/**
 * The asks' request operands with a declared rule difference (the lead's R41): a question or text an ask shows, which
 * `fieldText` refuses as a list or a value that shows no text (TSR021; a basic ask's question as it is said, at the
 * value, any other at the ask); a prefill, which the request refuses as it opens (`interactionPrefill`,
 * `temporalPrefill`, `materializeInteractionUi`, `materializeForm`: TSR052 at the ask); a choice's buttons
 * (`expandChoiceOptions`, TSR052 at the ask). An ask's form of R18's third way (R38): the request opens no field or
 * button and the run does not wait; a basic ask's question may already have been said.
 */
export const ASK_POSITIONS: readonly {
  readonly row: SyntaxKind;
  readonly operand: string;
  readonly today: readonly string[];
  readonly failure: readonly string[];
  readonly at: "value" | "ask";
}[] = [
  ...[...PREFILLED_ASKS, "askPassword"].flatMap((ask) => [
    {
      operand: `${ask}.question`,
      today: ["TSV040", "TSV042"],
      failure: ["TSR021"],
      at: "value" as const,
    },
    {
      operand: `${ask}.hint`,
      today: ["TSV040", "TSV042"],
      failure: ["TSR021"],
      at: "ask" as const,
    },
    ...(ask === "askPassword"
      ? []
      : [
          { operand: `${ask}.prefill`, today: ["TSV039"], failure: ["TSR052"], at: "ask" as const },
        ]),
  ]),
  ...["askBoolean.question", "askBoolean.yesText", "askBoolean.noText"].map((operand) => ({
    operand,
    today: ["TSV040", "TSV042"],
    failure: ["TSR021"],
    at: "ask" as const,
  })),
  { operand: "askBoolean.prefill", today: ["TSV039"], failure: ["TSR052"], at: "ask" as const },
  ...["askChoice.option", "askChoice.element", "askChoice.label", "askChoice.background"].map(
    (operand) => ({ operand, today: ["TSV029"], failure: ["TSR052"], at: "ask" as const }),
  ),
].map((position) => ({ row: "interactionExpression" as const, ...position }));
