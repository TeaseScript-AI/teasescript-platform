/*
 * The asks' part of the row guard's tables.
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
 * The operand positions of the asks (`askParts`) but the prefills (`PREFILL_OPERANDS`), by ask and operand, each a `let`
 * of the answer with the host global there. An `askChoice`'s option stands alone, so the buttons' kinds are the
 * sample's (two kinds are refused as a mixed choice, `outsideAnswers`).
 */
export const ASK_OPERANDS: Readonly<Record<string, readonly string[]>> = {
  ...Object.fromEntries(
    [...PREFILLED_ASKS, "askPassword"].flatMap((ask) => [
      [`${ask}.question`, [`let r = ${ask}(hostValue)`]],
      [`${ask}.hint`, [`let r = ${ask}("q", hint: hostValue)`]],
    ]),
  ),
  "askText.presentation": ['let r = askText bubble(color: hostValue) "q"'],
  "askBoolean.question": [
    "let r = askBoolean(hostValue)",
    "let r = askBoolean(message: hostValue)",
  ],
  "askBoolean.yesText": ['let r = askBoolean("q", yesText: hostValue)'],
  "askBoolean.noText": ['let r = askBoolean("q", noText: hostValue)'],
  "askBoolean.presentation": ['let r = askBoolean prose(align: hostValue) "q"'],
  "askChoice.option": ["let r = askChoice hostValue"],
  "askChoice.element": ["let r = askChoice [hostValue]"],
  "askChoice.label": ["let r = askChoice a: hostValue"],
  "askChoice.labelledElement": ["let r = askChoice a: [hostValue]"],
  "askChoice.background": ['let r = askChoice {text: "t", background: hostValue}'],
  "askChoice.text": ["let r = askChoice {text: hostValue, value: 1}"],
};

/**
 * The prefill positions, each a `let` of the answer with the host global there. The slice takes a prefill only as a
 * literal the request takes as written (`PREFILL_LITERALS`), so the host global there, and every computed value, is a
 * declared refusal at the row (`askPrefillAdmitted`), not a template that publishes.
 */
export const PREFILL_OPERANDS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    PREFILLED_ASKS.map((ask) => [`${ask}.prefill`, `let r = ${ask}("q", prefill: hostValue)`]),
  ),
  "askBoolean.prefill": 'let r = askBoolean("q", prefill: hostValue)',
  "askChoice.prefill": "let r = askChoice 1, 2, prefill: hostValue",
};

/** The literals the slice writes in place that are scalars: the ones a prefill written as a literal is read as. */
const SCALAR_LITERALS: readonly string[] = ["integer", "number", "string", "boolean", "null"];

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
  "askChoice.prefill": SCALAR_LITERALS,
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
