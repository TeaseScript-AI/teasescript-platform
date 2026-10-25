import { isNormalizedOpaqueColor } from "../../color.js";
import { isInteractionChoiceValue } from "../../choice-values.js";
import { isValidInteractionPrefill } from "../../interaction-answers.js";
import { validImageRequestFields } from "../../image-input.js";
import { canonicalWebUrl } from "../../web-url.js";
import {
  boundedInteractionUtf8ByteLength,
  interactionStringHasNonWhitespace,
  MAX_INTERACTION_AGGREGATE_UTF8_BYTES,
  MAX_INTERACTION_OPTION_ENTRIES,
} from "../../interaction-limits.js";
import { recordValidationTestWork } from "../../validation-testing.js";
import { INTERACTION_KINDS, type PreparedFormShape } from "../model.js";
import {
  type PlanValidationError,
  hasExactKeys,
  isRecord,
  isOneOf,
  planError,
  requireString,
  validateTemporaryId,
} from "../validation-support.js";
import { validateTypePlan } from "./type-plans.js";

export function validateInteractionInstruction(
  value: Record<string, unknown>,
  path: string,
  temporaryCount: number,
  errors: PlanValidationError[],
): void {
  const prepared = Object.hasOwn(value, "preparedUi") || Object.hasOwn(value, "speakerTemporary");
  const expectedKeys = prepared
    ? [
        "kind",
        "interactionKind",
        "target",
        "speakerTemporary",
        "destinationTemporary",
        "expectedResult",
        "preparedUi",
        "span",
      ]
    : [
        "kind",
        "interactionKind",
        "target",
        "speaker",
        "destinationTemporary",
        "expectedResult",
        "ui",
        "span",
      ];
  if (!hasExactKeys(value, expectedKeys)) {
    errors.push(planError("TSC002", "Interaction instruction contains unsupported fields.", path));
  }
  const kind = value.interactionKind;
  if (!isOneOf(kind, INTERACTION_KINDS)) {
    errors.push(planError("TSC002", "Interaction kind is invalid.", `${path}.interactionKind`));
  }
  // A form reads its fields when it opens, and `exportText` its text, so both are always prepared.
  if ((kind === "form" || kind === "export") && !prepared)
    errors.push(planError("TSC002", `A ${kind} interaction must be prepared.`, path));
  if (value.target !== "standardChat")
    errors.push(planError("TSC002", "Interaction target is invalid.", `${path}.target`));

  const ui = prepared ? value.preparedUi : value.ui;
  const expected =
    kind === "button" || kind === "popup" || kind === "url" || kind === "export"
      ? value.destinationTemporary === null
        ? "none"
        : "duration"
      : kind === "number"
        ? "number"
        : kind === "choice"
          ? "choice"
          : kind === "temporal"
            ? "temporal"
            : kind === "form"
              ? "form"
              : "string";
  if (value.expectedResult !== expected) {
    errors.push(
      planError(
        "TSC002",
        "Interaction result domain does not match its kind.",
        `${path}.expectedResult`,
      ),
    );
  }
  // `openUrl` and `exportText` give no value.
  if (kind === "url" || kind === "export") {
    if (value.destinationTemporary !== null)
      errors.push(
        planError(
          "TSC002",
          `${kind === "url" ? "openUrl" : "exportText"} has no result destination.`,
          `${path}.destinationTemporary`,
        ),
      );
  } else if ((kind !== "button" && kind !== "popup") || value.destinationTemporary !== null) {
    validateTemporaryId(
      value.destinationTemporary,
      `${path}.destinationTemporary`,
      temporaryCount,
      errors,
    );
  }

  if (prepared) {
    validateTemporaryId(value.speakerTemporary, `${path}.speakerTemporary`, temporaryCount, errors);
    if (value.destinationTemporary === value.speakerTemporary) {
      errors.push(
        planError(
          "TSC002",
          "Interaction result destination must not alias its prepared speaker temporary.",
          `${path}.destinationTemporary`,
        ),
      );
    }
    validatePreparedInteractionUi(
      kind,
      ui,
      `${path}.preparedUi`,
      temporaryCount,
      value.speakerTemporary,
      value.destinationTemporary,
      errors,
    );
    return;
  }

  if (value.speaker !== null) requireString(value.speaker, `${path}.speaker`, errors);
  validateStaticInteractionUi(kind, ui, `${path}.ui`, errors);
}

function validateStaticInteractionUi(
  kind: unknown,
  ui: unknown,
  path: string,
  errors: PlanValidationError[],
): void {
  if (!isRecord(ui) || ui.kind !== kind) {
    errors.push(planError("TSC002", "Interaction UI payload does not match its kind.", path));
    return;
  }
  const uiKeys =
    kind === "button"
      ? ["kind", "buttonLabel", "accessibleName", ...("background" in ui ? ["background"] : [])]
      : kind === "text" || kind === "number" || kind === "temporal" || kind === "password"
        ? [
            "kind",
            "hint",
            "accessibleName",
            // A password is never suggested.
            ...("prefill" in ui && kind !== "password" ? ["prefill"] : []),
            ...(kind === "number" && "integer" in ui ? ["integer"] : []),
            ...(kind === "temporal" ? ["temporalKind"] : []),
          ]
        : kind === "image"
          ? [
              "kind",
              "question",
              "hint",
              "accessibleName",
              "allowCamera",
              "allowFile",
              "allowSkip",
              "types",
              "mime",
            ]
          : kind === "popup"
            ? ["kind", "message", "buttonText", "accessibleName"]
            : kind === "url"
              ? ["kind", "url", "buttonText", "alwaysButton", "accessibleName"]
              : [
                  "kind",
                  "options",
                  "accessibleName",
                  ...("preselected" in ui ? ["preselected"] : []),
                ];
  if (
    !hasExactKeys(ui, uiKeys) ||
    ("integer" in ui && ui.integer !== true) ||
    (kind === "temporal" && !isOneOf(ui.temporalKind, ["date", "time", "datetime"]))
  ) {
    errors.push(planError("TSC002", "Interaction UI payload contains unsupported fields.", path));
  }
  let aggregate = 0;
  let measurementExhausted = false;
  const countString = (candidate: unknown, fieldPath: string): candidate is string => {
    if (typeof candidate !== "string") {
      errors.push(planError("TSC002", "Interaction text must be a string.", fieldPath));
      return false;
    }
    if (measurementExhausted) {
      if (candidate.length > Math.max(0, MAX_INTERACTION_AGGREGATE_UTF8_BYTES - aggregate)) {
        errors.push(
          planError(
            "TSC002",
            "Interaction text exceeds the remaining aggregate UTF-8 byte limit.",
            fieldPath,
          ),
        );
        return false;
      }
      return true;
    }
    recordValidationTestWork("interactionUtf8Measurements");
    const bytes = boundedInteractionUtf8ByteLength(
      candidate,
      MAX_INTERACTION_AGGREGATE_UTF8_BYTES - aggregate,
    );
    if (bytes === null) {
      measurementExhausted = true;
      errors.push(
        planError(
          "TSC002",
          "Interaction text exceeds the remaining aggregate UTF-8 byte limit.",
          fieldPath,
        ),
      );
      return false;
    }
    aggregate += bytes;
    return true;
  };
  validateInteractionAccessibleName(
    kind,
    ui.accessibleName,
    `${path}.accessibleName`,
    countString,
    measurementExhausted,
    errors,
  );
  if (kind === "popup") {
    countString(ui.message, `${path}.message`);
    countString(ui.buttonText, `${path}.buttonText`);
  }
  if (kind === "url") {
    // The address is canonical.
    if (countString(ui.url, `${path}.url`) && canonicalWebUrl(ui.url) !== ui.url)
      errors.push(planError("TSC002", "The web address of openUrl is invalid.", `${path}.url`));
    countString(ui.buttonText, `${path}.buttonText`);
    if (typeof ui.alwaysButton !== "boolean")
      errors.push(
        planError("TSC002", "openUrl's alwaysButton must be a boolean.", `${path}.alwaysButton`),
      );
  }
  if (kind === "button") {
    countString(ui.buttonLabel, `${path}.buttonLabel`);
    if ("background" in ui && !isNormalizedOpaqueColor(ui.background))
      errors.push(planError("TSC002", "Invalid opaque button background.", `${path}.background`));
  }
  if (kind === "password" && ui.hint !== null) countString(ui.hint, `${path}.hint`);
  if (kind === "text" || kind === "number" || kind === "temporal") {
    if (ui.hint !== null) countString(ui.hint, `${path}.hint`);
    const temporalKind = ui.temporalKind;
    const answerKind =
      temporalKind === "date" || temporalKind === "time" || temporalKind === "datetime"
        ? temporalKind
        : ui.integer === true
          ? "integer"
          : kind === "number"
            ? "number"
            : "text";
    if (
      "prefill" in ui &&
      countString(ui.prefill, `${path}.prefill`) &&
      !isValidInteractionPrefill(answerKind, ui.prefill)
    )
      errors.push(
        planError("TSC002", "Interaction prefill is not a valid answer.", `${path}.prefill`),
      );
  }
  if (kind === "image") {
    if (ui.question !== null) countString(ui.question, `${path}.question`);
    if (ui.hint !== null) countString(ui.hint, `${path}.hint`);
    if (!validImageRequestFields(ui, (text) => countString(text, path)))
      errors.push(planError("TSC002", "Image request is invalid.", path));
  }
  if (kind === "choice") {
    if (
      !Array.isArray(ui.options) ||
      ui.options.length === 0 ||
      ui.options.length > MAX_INTERACTION_OPTION_ENTRIES
    ) {
      errors.push(
        planError(
          "TSC002",
          "Choice options exceed the shared collection boundary or are empty.",
          `${path}.options`,
        ),
      );
    } else {
      for (let index = 0; index < ui.options.length; index += 1) {
        const option = ui.options[index];
        const optionPath = `${path}.options[${index}]`;
        if (!isRecord(option)) {
          errors.push(planError("TSC002", "Choice option must be an object.", optionPath));
          continue;
        }
        if (
          !hasExactKeys(option, [
            "text",
            "value",
            ...("background" in option ? ["background"] : []),
          ])
        ) {
          errors.push(
            planError("TSC002", "Choice option contains unsupported fields.", optionPath),
          );
        }
        if ("background" in option && !isNormalizedOpaqueColor(option.background))
          errors.push(
            planError("TSC002", "Invalid opaque choice background.", `${optionPath}.background`),
          );
        countString(option.text, `${optionPath}.text`);
        const value = option.value;
        if (!isInteractionChoiceValue(value)) {
          errors.push(
            planError("TSC002", "Choice option value is invalid.", `${optionPath}.value`),
          );
          continue;
        }
        if (typeof value === "string" && value !== option.text)
          countString(value, `${optionPath}.value`);
      }
      const preselected = "preselected" in ui ? ui.preselected : 0;
      if (
        typeof preselected !== "number" ||
        !Number.isSafeInteger(preselected) ||
        preselected < 0 ||
        preselected >= ui.options.length
      )
        errors.push(
          planError("TSC002", "The preselected choice is not a button.", `${path}.preselected`),
        );
    }
  }
}

function validatePreparedInteractionUi(
  kind: unknown,
  ui: unknown,
  path: string,
  temporaryCount: number,
  speakerTemporary: unknown,
  destinationTemporary: unknown,
  errors: PlanValidationError[],
): void {
  if (!isRecord(ui) || ui.kind !== kind) {
    errors.push(
      planError("TSC002", "Prepared interaction UI payload does not match its kind.", path),
    );
    return;
  }
  const keys =
    kind === "button"
      ? [
          "kind",
          "buttonLabelTemporary",
          "accessibleName",
          ...("backgroundTemporary" in ui ? ["backgroundTemporary"] : []),
          ...("timeoutTemporary" in ui ? ["timeoutTemporary"] : []),
        ]
      : kind === "text" || kind === "number" || kind === "temporal" || kind === "password"
        ? [
            "kind",
            "hintTemporary",
            "accessibleName",
            ...("prefillTemporary" in ui && kind !== "password" ? ["prefillTemporary"] : []),
            ...(kind === "number" && "integer" in ui ? ["integer"] : []),
            ...(kind === "temporal" ? ["temporalKind"] : []),
          ]
        : kind === "image"
          ? ["kind", "requestTemporary", "accessibleName"]
          : kind === "form"
            ? ["kind", "requestTemporary", "shape", "accessibleName"]
            : kind === "popup"
              ? [
                  "kind",
                  "messageTemporary",
                  "accessibleName",
                  ...("buttonTextTemporary" in ui ? ["buttonTextTemporary"] : []),
                ]
              : kind === "url"
                ? [
                    "kind",
                    "urlTemporary",
                    "accessibleName",
                    ...("buttonTextTemporary" in ui ? ["buttonTextTemporary"] : []),
                    ...("alwaysButtonTemporary" in ui ? ["alwaysButtonTemporary"] : []),
                  ]
                : kind === "export"
                  ? [
                      "kind",
                      "textTemporary",
                      "accessibleName",
                      ...("titleTemporary" in ui ? ["titleTemporary"] : []),
                      ...("fileNameTemporary" in ui ? ["fileNameTemporary"] : []),
                    ]
                  : [
                      "kind",
                      "optionsTemporary",
                      "values",
                      "accessibleName",
                      ...("prefillTemporary" in ui ? ["prefillTemporary"] : []),
                      ...("booleanPrefill" in ui ? ["booleanPrefill"] : []),
                    ];
  if (
    !hasExactKeys(ui, keys) ||
    ("integer" in ui && ui.integer !== true) ||
    ("booleanPrefill" in ui && (ui.booleanPrefill !== true || !("prefillTemporary" in ui))) ||
    (kind === "temporal" && !isOneOf(ui.temporalKind, ["date", "time", "datetime"]))
  ) {
    errors.push(
      planError("TSC002", "Prepared interaction UI payload contains unsupported fields.", path),
    );
  }
  let aggregate = 0;
  let measurementExhausted = false;
  const countString = (candidate: unknown, fieldPath: string): candidate is string => {
    if (typeof candidate !== "string") {
      errors.push(planError("TSC002", "Interaction text must be a string.", fieldPath));
      return false;
    }
    if (measurementExhausted) {
      if (candidate.length > Math.max(0, MAX_INTERACTION_AGGREGATE_UTF8_BYTES - aggregate)) {
        errors.push(
          planError(
            "TSC002",
            "Interaction text exceeds the remaining aggregate UTF-8 byte limit.",
            fieldPath,
          ),
        );
        return false;
      }
      return true;
    }
    recordValidationTestWork("interactionUtf8Measurements");
    const bytes = boundedInteractionUtf8ByteLength(
      candidate,
      MAX_INTERACTION_AGGREGATE_UTF8_BYTES - aggregate,
    );
    if (bytes === null) {
      measurementExhausted = true;
      errors.push(
        planError(
          "TSC002",
          "Interaction text exceeds the remaining aggregate UTF-8 byte limit.",
          fieldPath,
        ),
      );
      return false;
    }
    aggregate += bytes;
    return true;
  };
  validateInteractionAccessibleName(
    kind,
    ui.accessibleName,
    `${path}.accessibleName`,
    countString,
    measurementExhausted,
    errors,
  );
  const used = new Set<number>();
  const addTemporary = (value: unknown, fieldPath: string): void => {
    validateTemporaryId(value, fieldPath, temporaryCount, errors);
    if (typeof value === "number") {
      if (value === speakerTemporary || value === destinationTemporary || used.has(value)) {
        errors.push(
          planError(
            "TSC002",
            "Prepared interaction temporaries must be pairwise distinct.",
            fieldPath,
          ),
        );
      }
      used.add(value);
    }
  };
  if (kind === "button") {
    addTemporary(ui.buttonLabelTemporary, `${path}.buttonLabelTemporary`);
    if ("backgroundTemporary" in ui)
      addTemporary(ui.backgroundTemporary, `${path}.backgroundTemporary`);
    if ("timeoutTemporary" in ui) addTemporary(ui.timeoutTemporary, `${path}.timeoutTemporary`);
    return;
  }
  if (kind === "popup") {
    addTemporary(ui.messageTemporary, `${path}.messageTemporary`);
    if ("buttonTextTemporary" in ui)
      addTemporary(ui.buttonTextTemporary, `${path}.buttonTextTemporary`);
    return;
  }
  if (kind === "url") {
    addTemporary(ui.urlTemporary, `${path}.urlTemporary`);
    if ("buttonTextTemporary" in ui)
      addTemporary(ui.buttonTextTemporary, `${path}.buttonTextTemporary`);
    if ("alwaysButtonTemporary" in ui)
      addTemporary(ui.alwaysButtonTemporary, `${path}.alwaysButtonTemporary`);
    return;
  }
  if (kind === "export") {
    addTemporary(ui.textTemporary, `${path}.textTemporary`);
    if ("titleTemporary" in ui) addTemporary(ui.titleTemporary, `${path}.titleTemporary`);
    if ("fileNameTemporary" in ui) addTemporary(ui.fileNameTemporary, `${path}.fileNameTemporary`);
    return;
  }
  if (kind === "text" || kind === "number" || kind === "temporal" || kind === "password") {
    if (ui.hintTemporary !== null) addTemporary(ui.hintTemporary, `${path}.hintTemporary`);
    if ("prefillTemporary" in ui) addTemporary(ui.prefillTemporary, `${path}.prefillTemporary`);
    return;
  }
  if (kind === "image") {
    addTemporary(ui.requestTemporary, `${path}.requestTemporary`);
    return;
  }
  if (kind === "form") {
    addTemporary(ui.requestTemporary, `${path}.requestTemporary`);
    if (!validPreparedFormShape(ui.shape))
      errors.push(planError("TSC002", "Prepared form shape is invalid.", `${path}.shape`));
    else if (ui.shape.kind === "object")
      ui.shape.answers.forEach((answer, index) =>
        validateTypePlan(answer.type, `${path}.shape.answers[${index}].type`, errors),
      );
    else if (ui.shape.kind === "dict" && ui.shape.answer !== null)
      validateTypePlan(ui.shape.answer, `${path}.shape.answer`, errors);
    return;
  }
  if (kind !== "choice") return;
  addTemporary(ui.optionsTemporary, `${path}.optionsTemporary`);
  if ("prefillTemporary" in ui) addTemporary(ui.prefillTemporary, `${path}.prefillTemporary`);
  if (
    !Array.isArray(ui.values) ||
    ui.values.length === 0 ||
    ui.values.length > MAX_INTERACTION_OPTION_ENTRIES
  ) {
    errors.push(
      planError(
        "TSC002",
        "Prepared choice values exceed the shared collection boundary or are empty.",
        `${path}.values`,
      ),
    );
    return;
  }
  for (let index = 0; index < ui.values.length; index += 1) {
    const value = ui.values[index];
    if (value === null) continue;
    const valuePath = `${path}.values[${index}]`;
    const valid =
      typeof value === "string"
        ? countString(value, valuePath) && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)
        : typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0);
    if (!valid) {
      errors.push(planError("TSC002", "Prepared choice value is invalid.", valuePath));
    }
  }
}

/**
 * An object form names each numeric field once by its unique name; a dict form has one numeric kind or `null`; an
 * unknown form and a boolean list have none.
 */
function validPreparedFormShape(value: unknown): value is PreparedFormShape {
  if (!isRecord(value)) return false;
  const numericKind = (kind: unknown) => kind === "integer" || kind === "number";
  if (value.kind === "booleanList" || value.kind === "unknown")
    return hasExactKeys(value, ["kind"]);
  if (value.kind === "dict")
    return (
      hasExactKeys(value, ["kind", "numericKind", "answer"]) &&
      (value.numericKind === null || numericKind(value.numericKind))
    );
  if (value.kind !== "object" || !hasExactKeys(value, ["kind", "numericKinds", "answers"]))
    return false;
  const kinds = value.numericKinds;
  const answers = value.answers;
  if (
    !Array.isArray(kinds) ||
    kinds.length > MAX_INTERACTION_OPTION_ENTRIES ||
    !Array.isArray(answers) ||
    answers.length > MAX_INTERACTION_OPTION_ENTRIES
  )
    return false;
  // Each answer type is checked as a type by the caller.
  const answered = new Set<unknown>();
  if (
    !answers.every((entry: unknown) => {
      if (
        !isRecord(entry) ||
        !hasExactKeys(entry, ["name", "type"]) ||
        typeof entry.name !== "string" ||
        answered.has(entry.name)
      )
        return false;
      answered.add(entry.name);
      return true;
    })
  )
    return false;
  const names = new Set<unknown>();
  return kinds.every((entry: unknown) => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ["name", "numericKind"]) ||
      typeof entry.name !== "string" ||
      names.has(entry.name) ||
      !numericKind(entry.numericKind)
    )
      return false;
    names.add(entry.name);
    return true;
  });
}

function validateInteractionAccessibleName(
  kind: unknown,
  accessible: unknown,
  path: string,
  countString: (candidate: unknown, fieldPath: string) => candidate is string,
  measurementExhausted: boolean,
  errors: PlanValidationError[],
): void {
  if (
    !isRecord(accessible) ||
    (accessible.kind !== "text" && accessible.kind !== "localizedDefault")
  ) {
    errors.push(planError("TSC002", "Interaction accessible name is invalid.", path));
    return;
  }
  if (accessible.kind === "text") {
    if (!hasExactKeys(accessible, ["kind", "text"])) {
      errors.push(
        planError("TSC002", "Interaction accessible name contains unsupported fields.", path),
      );
    }
    if (
      countString(accessible.text, `${path}.text`) &&
      !measurementExhausted &&
      !interactionStringHasNonWhitespace(accessible.text)
    ) {
      errors.push(
        planError(
          "TSC002",
          "Explicit interaction accessible name must contain a non-whitespace character.",
          `${path}.text`,
        ),
      );
    }
    return;
  }
  if (!hasExactKeys(accessible, ["kind", "key"])) {
    errors.push(
      planError("TSC002", "Interaction accessible name contains unsupported fields.", path),
    );
  }
  const expectedKey =
    kind === "button" || kind === "popup" || kind === "url" || kind === "export"
      ? "continue"
      : kind === "number"
        ? "number"
        : kind === "choice"
          ? "chooseOption"
          : kind === "password"
            ? "password"
            : "answer";
  if (accessible.key !== expectedKey) {
    errors.push(
      planError(
        "TSC002",
        "Interaction localized accessible-name key does not match its kind.",
        `${path}.key`,
      ),
    );
  }
}
